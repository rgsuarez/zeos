"""
Standard Worker implementation for Team Protocol.

Robust worker that handles task assignments, manages safety whitelists,
and supports multi-line command execution with Coordination Multiplier heartbeats.
"""

import hashlib
import re
import shlex
import subprocess
import threading
import time
from typing import Optional, Tuple, List

from overseer.hive import (
    Worker,
    Task,
    TaskAcceptance,
    TaskCompletion,
    TaskBlocker,
    TaskStatus,
    TaskResultStatus,
    Heartbeat,
)

# Safe commands whitelist (read-only operations)
SAFE_COMMANDS = {
    "ls", "cat", "echo", "pwd", "head", "tail", "wc", "grep",
    "find", "which", "whoami", "date", "env", "printenv",
    "file", "stat", "du", "df", "tree", "less", "more", "git status", "git diff"
}


class StandardWorker(Worker):
    """
    Standard worker implementation.

    Receives tasks via TASK_ASSIGN, executes them, and reports
    completion via TASK_COMPLETE. Includes Coordination Multiplier heartbeat support.
    """

    def __init__(self, name: str, safe_mode: bool = True):
        super().__init__(name)
        self.task_history: list[Task] = []
        self.safe_mode = safe_mode
        # Coordination Multiplier Evolution
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._heartbeat_stop_event = threading.Event()
        self._current_action = ""
        self._progress_pct = 0

    def _compute_terminal_hash(self) -> str:
        """Compute hash of own terminal output for activity proof."""
        try:
            result = subprocess.run(
                ["tmux", "capture-pane", "-t", self.name, "-p", "-S", "-50"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                return hashlib.sha256(result.stdout[-500:].encode()).hexdigest()[:8]
        except Exception:
            pass
        return "unknown"

    def _heartbeat_loop(self, task: Task):
        """
        Background heartbeat loop (Coordination Multiplier Protocol).

        Posts heartbeats every `heartbeat_interval_sec` while task is in progress.
        """
        interval = task.heartbeat_interval_sec or 60

        while not self._heartbeat_stop_event.wait(timeout=interval):
            if self.current_task is None:
                break

            heartbeat = Heartbeat(
                worker=self.name,
                task_id=task.task_id,
                progress_pct=self._progress_pct,
                current_action=self._current_action,
                terminal_hash=self._compute_terminal_hash()
            )

            # Post heartbeat via relay (import here to avoid circular)
            try:
                from overseer.server import post_heartbeat
                post_heartbeat(
                    worker=self.name,
                    task_id=task.task_id,
                    progress_pct=self._progress_pct,
                    current_action=self._current_action,
                    terminal_hash=heartbeat.terminal_hash
                )
            except Exception:
                # Silently continue if heartbeat fails
                pass

    def _start_heartbeat(self, task: Task):
        """Start background heartbeat thread for task."""
        self._heartbeat_stop_event.clear()
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            args=(task,),
            daemon=True
        )
        self._heartbeat_thread.start()

    def _stop_heartbeat(self):
        """Stop background heartbeat thread."""
        self._heartbeat_stop_event.set()
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            self._heartbeat_thread.join(timeout=2)
        self._heartbeat_thread = None

    def set_progress(self, pct: int, action: str = ""):
        """Update progress for heartbeat reporting."""
        self._progress_pct = max(0, min(100, pct))
        if action:
            self._current_action = action

    def handle_assignment(self, task: Task) -> TaskAcceptance:
        """Accept incoming task assignment."""
        self.current_task = task
        task.status = TaskStatus.ACCEPTED

        # Basic estimation
        estimated = 30
        if task.priority.value == "critical":
            estimated = 5
        elif task.priority.value == "high":
            estimated = 15

        return TaskAcceptance(
            task_id=task.task_id,
            worker=self.name,
            estimated_seconds=estimated
        )

    def execute(self, task: Task) -> TaskCompletion:
        """Execute the assigned task (Mock)."""
        task.status = TaskStatus.IN_PROGRESS
        time.sleep(2)
        task.status = TaskStatus.COMPLETED
        self.task_history.append(task)
        self.current_task = None

        return TaskCompletion(
            task_id=task.task_id,
            worker=self.name,
            status=TaskResultStatus.SUCCESS,
            result=f"Task '{task.description}' completed (mock)",
            artifacts=[],
            notes="Use execute_real for actual execution"
        )

    def _extract_command(self, task: Task) -> Optional[str]:
        """
        Extract shell command from task description or context.
        Supports:
        - Content within backticks `ls -la`
        - Content after "run:" or "execute:"
        - Multi-line notes if they contain shell-like structure
        - Fallback to description if it looks like a command
        """
        search_targets = []
        if task.context and task.context.notes:
            search_targets.append(task.context.notes)
        search_targets.append(task.description)

        for target in search_targets:
            # 1. Backticks
            match = re.search(r'```(?:bash|sh)?\n(.*?)\n```', target, re.DOTALL)
            if match:
                return match.group(1).strip()
            match = re.search(r'`([^`]+)`', target)
            if match:
                return match.group(1).strip()

            # 2. run: prefix
            match = re.search(r'(?:run|execute|cmd):\s*(.+)', target, re.IGNORECASE | re.DOTALL)
            if match:
                return match.group(1).strip()

        # 3. Heuristic: If it's a single line and starts with a common command
        first_line = task.description.splitlines()[0].strip()
        parts = first_line.split()
        if parts and parts[0] in SAFE_COMMANDS:
            return task.description.strip()

        return None

    def _is_safe_command(self, command: str) -> Tuple[bool, str]:
        """Check if command is in the safe whitelist."""
        if not self.safe_mode:
            return True, "Safe mode disabled"

        # Split multi-line commands and check each
        lines = [line.strip() for line in command.splitlines() if line.strip()]
        if not lines:
            return False, "Empty command"

        for line in lines:
            try:
                # Handle pipes
                sub_commands = [c.strip() for c in line.split('|')]
                for sub in sub_commands:
                    try:
                        parts = shlex.split(sub, comments=True)
                    except ValueError:
                        return False, f"Invalid shell syntax in: {sub}"
                        
                    if not parts:
                        continue
                    
                    base_cmd = parts[0].split('/')[-1]
                    # Specific check for 'git status' etc
                    full_cmd_check = " ".join(parts[:2])
                    
                    if base_cmd not in SAFE_COMMANDS and full_cmd_check not in SAFE_COMMANDS:
                        return False, f"Command '{base_cmd}' (or '{full_cmd_check}') not in whitelist"
            except ValueError as e:
                return False, f"Failed to parse command line: {line} - {e}"

        return True, "All sub-commands whitelisted"

    def _run_command(self, command: str, timeout: int = 60) -> Tuple[bool, str, str]:
        """Execute shell command with timeout."""
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd="~/projects/overseer"
            )
            return (
                result.returncode == 0,
                result.stdout,
                result.stderr
            )
        except subprocess.TimeoutExpired:
            return False, "", f"Command timed out after {timeout}s"
        except Exception as e:
            return False, "", str(e)

    def execute_real(self, task: Task) -> TaskCompletion:
        """Execute task with actual shell command execution and heartbeat support."""
        task.status = TaskStatus.IN_PROGRESS

        # Start heartbeat loop (Coordination Multiplier Protocol)
        self.set_progress(0, "Extracting command")
        self._start_heartbeat(task)

        try:
            command = self._extract_command(task)
            if not command:
                task.status = TaskStatus.FAILED
                return TaskCompletion(
                    task_id=task.task_id,
                    worker=self.name,
                    status=TaskResultStatus.FAILED,
                    result="No valid command extracted from task",
                    notes="Hint: Use `backticks` or 'run:' prefix"
                )

            self.set_progress(10, "Validating command safety")

            # Context-based safe mode override
            effective_safe_mode = self.safe_mode
            if task.context and task.context.extra.get("UNSAFE_OVERRIDE") is True:
                effective_safe_mode = False

            if effective_safe_mode:
                is_safe, reason = self._is_safe_command(command)
                if not is_safe:
                    task.status = TaskStatus.BLOCKED
                    return TaskCompletion(
                        task_id=task.task_id,
                        worker=self.name,
                        status=TaskResultStatus.FAILED,
                        result=f"Blocked: {reason}",
                        notes="Set UNSAFE_OVERRIDE: true in extra context to bypass"
                    )

            self.set_progress(20, f"Executing: {command[:50]}")
            success, stdout, stderr = self._run_command(command)

            self.set_progress(90, "Processing output")
            task.status = TaskStatus.COMPLETED if success else TaskStatus.FAILED
            self.task_history.append(task)
            self.current_task = None

            max_output = 5000
            if len(stdout) > max_output:
                stdout = stdout[:max_output] + f"\n... (truncated)"

            self.set_progress(100, "Complete")
            return TaskCompletion(
                task_id=task.task_id,
                worker=self.name,
                status=TaskResultStatus.SUCCESS if success else TaskResultStatus.FAILED,
                result=stdout if stdout else "(no stdout)",
                notes=stderr if stderr else f"Executed: {command}"
            )
        finally:
            # Always stop heartbeat when task completes
            self._stop_heartbeat()


class ClaudeWorker(StandardWorker):
    """Specific ClaudeWorker (currently uses standard logic)."""
    def __init__(self, name: str = "claude", safe_mode: bool = True):
        super().__init__(name, safe_mode)


class CodexWorker(StandardWorker):
    """Specific CodexWorker (could add python-specific validation)."""
    def __init__(self, name: str = "codex", safe_mode: bool = True):
        super().__init__(name, safe_mode)
    
    def _is_safe_command(self, command: str) -> Tuple[bool, str]:
        # Add 'python' to safe commands for Codex specifically
        is_safe, reason = super()._is_safe_command(command)
        if is_safe:
            return True, reason
        
        # Check if it's a python run
        parts = command.split()
        if parts and parts[0] in ["python", "python3", "pytest"]:
             # For Codex, we might allow python runs if we trust the context
             return True, "Codex authorized for Python execution"
             
        return is_safe, reason