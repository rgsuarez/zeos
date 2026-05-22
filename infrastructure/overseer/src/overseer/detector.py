"""
Overseer State Detection

Analyzes agent output to determine current operational state:
- IDLE: Waiting for user input
- WORKING: Executing tools or thinking
- WAITING: Blocked on user confirmation/input
- ERROR: Encountered an error
"""

import hashlib
import re
import time
from enum import Enum
from typing import List, Dict

STUCK_THRESHOLD_SEC = 300  # 5 minutes static WORKING output
STALE_THRESHOLD_SEC = 600  # 10 minutes no output changes
LOOP_REPEAT_THRESHOLD = 5  # 5x identical tail lines

class AgentState(str, Enum):
    IDLE = "idle"
    WORKING = "working"
    WAITING = "waiting"
    ERROR = "error"
    STUCK = "stuck"      # Working state but no output change for long time
    STALE = "stale"      # No output update at all (possible crash)
    UNKNOWN = "unknown"

class StateDetector:
    """Detects agent state based on terminal output patterns and temporal changes."""

    def __init__(self):
        # agent -> {"last_output": str, "last_output_hash": str, "last_change": float, "stable_count": int}
        self.history: Dict[str, Dict] = {}
        
        # Default heuristics (can be extended per agent)
        self.heuristics: Dict[str, Dict[str, List[str]]] = {
            "gemini": {
                "idle": [r"^> ", r"Type your message", r"❯ $"],
                "working": [r"Thinking\.\.\.", r"╭───", r"[⠧⠋]"],
                "waiting": [r"\[y/N\]", r"Confirm\?", r"\(esc to cancel\)"],
                "error": [r"Error:", r"Traceback", r"Exception"]
            },
            "claude": {
                "idle": [r"\$ $", r"^> $", r"claude>", r"bypass permissions on", r"❯ $", r"shift\+Tab to cycle"],
                "working": [r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]", r"Reading", r"Writing", r"Searching", r"Editing", r"Thinking", r"∴ Thinking"],
                "waiting": [r"\[Y/n\]", r"\[y/N\]", r"Press enter", r"\(y/n\)", r"Allow"],
                "error": [r"Error:", r"failed", r"exception", r"FAILED"]
            },
            "codex": {
                "idle": [r"^› $", r"^> $", r"OpenAI Codex", r"❯ $", r"context left", r"\? for shortcuts"],
                "working": [r"• Working", r"Working \(\d+s", r"Thinking\.\.\.", r"Executing", r"^• ", r"esc to interrupt"],
                "waiting": [r"Confirm\?", r"\[y/n\]", r"Enter confirms"],
                "error": [r"Error:", r"failed", r"Exception"]
            },
            "kimi": {
                "idle": [r"operator@zeos", r"agent \(kimi", r"context: \d+\.\d+%", r"^> $", r"❯ $"],
                "working": [r"Using \w+", r"[⠦⠧⠇⠏⠋⠙⠹⠸⠼⠴]", r"⠼\s*Thinking", r"Searching\b", r"Reading\b"],
                "waiting": [r"requesting approval", r"Approve once", r"Approve for this session", r"\[y/n\]"],
                "error": [r"Error:", r"failed", r"Exception"]
            },
            "goose": {
                "idle": [r"^> $", r"goose>", r"operator@", r"Goose is ready"],
                "working": [r"WAITING_LLM_STREAM_START", r"WAITING_TOOL_START", r"Using model:", r"working on"],
                "waiting": [r"\[y/N\]", r"Confirm\?", r"Approve", r"\[Y/n\]"],
                "error": [r"Error:", r"failed", r"Exception", r"error:"]
            }
        }

    def _output_hash(self, text: str) -> str:
        normalized = text.strip()
        if not normalized:
            return ""
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def detect_loop(self, output: str) -> bool:
        lines = [line for line in output.splitlines() if line.strip()]
        if len(lines) < LOOP_REPEAT_THRESHOLD:
            return False
        tail = "\n".join(lines[-LOOP_REPEAT_THRESHOLD:])
        pattern = rf"^(?P<line>.+)(?:\n(?P=line)){{{LOOP_REPEAT_THRESHOLD - 1}}}$"
        return re.search(pattern, tail, re.MULTILINE) is not None

    def detect_frozen(
        self,
        detected_state: AgentState,
        time_since_change: float,
        loop_detected: bool
    ) -> AgentState:
        if time_since_change > STALE_THRESHOLD_SEC:
            return AgentState.STALE
        if detected_state == AgentState.WORKING:
            if loop_detected:
                return AgentState.STUCK
            if time_since_change > STUCK_THRESHOLD_SEC:
                return AgentState.STUCK
        return detected_state

    def detect(self, agent: str, output: str) -> AgentState:
        """
        Analyze output string and return probable state, including temporal 'stuck' detection.
        
        Priority: ERROR > WAITING > WORKING > IDLE > STUCK > STALE > UNKNOWN
        """
        # Initialize history for agent
        if agent not in self.history:
            self.history[agent] = {
                "last_output": output,
                "last_output_hash": "",
                "last_change": time.time(),
                "stable_count": 0,
                "last_state": AgentState.UNKNOWN
            }

        hist = self.history[agent]
        now = time.time()

        lines = output.splitlines()[-20:]
        recent_text = "\n".join(lines)
        output_hash = self._output_hash(recent_text)

        # Determine if output has changed (hash-based)
        changed = output_hash != hist["last_output_hash"]

        if changed:
            hist["last_change"] = now
            hist["stable_count"] = 0
            hist["last_output"] = output
            hist["last_output_hash"] = output_hash
        else:
            hist["stable_count"] += 1

        if agent not in self.heuristics:
            return AgentState.UNKNOWN
            
        patterns = self.heuristics[agent]
        # Analyze last 20 lines for recent context

        # Base state detection
        detected_state = AgentState.UNKNOWN
        
        # Check ERROR
        for pattern in patterns["error"]:
            if re.search(pattern, recent_text, re.IGNORECASE):
                detected_state = AgentState.ERROR
                break
                
        # Check WAITING
        if detected_state == AgentState.UNKNOWN:
            for pattern in patterns["waiting"]:
                if re.search(pattern, recent_text, re.IGNORECASE):
                    detected_state = AgentState.WAITING
                    break

        # Check WORKING
        if detected_state == AgentState.UNKNOWN:
            for pattern in patterns["working"]:
                if re.search(pattern, recent_text, re.IGNORECASE):
                    detected_state = AgentState.WORKING
                    break
                
        # Check IDLE (check last 20 lines for prompts/footers to account for TUI status bars)
        if detected_state == AgentState.UNKNOWN and lines:
            # Check all recent lines (up to 20) as TUI status bars can push prompts up
            for line in lines:
                for pattern in patterns["idle"]:
                    if re.search(pattern, line):
                        detected_state = AgentState.IDLE
                        break
                if detected_state != AgentState.UNKNOWN:
                    break

        # Temporal refinements (STUCK / STALE)
        time_since_change = now - hist["last_change"]
        loop_detected = self.detect_loop(recent_text)
        detected_state = self.detect_frozen(detected_state, time_since_change, loop_detected)
            
        hist["last_state"] = detected_state
        return detected_state
