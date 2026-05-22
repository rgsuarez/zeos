
import time
import pytest
from overseer.detector import StateDetector, AgentState

class TestStateDetector:
    def test_gemini_detection(self):
        detector = StateDetector()
        
        # Idle
        assert detector.detect("gemini", "> ") == AgentState.IDLE
        assert detector.detect("gemini", "Type your message") == AgentState.IDLE
        
        # Working
        assert detector.detect("gemini", "Thinking...") == AgentState.WORKING
        assert detector.detect("gemini", "╭───") == AgentState.WORKING
        assert detector.detect("gemini", "⠧") == AgentState.WORKING
        
        # Waiting
        assert detector.detect("gemini", "Confirm? [y/N]") == AgentState.WAITING
        assert detector.detect("gemini", "(esc to cancel)") == AgentState.WAITING
        
        # Error
        assert detector.detect("gemini", "Error: Something went wrong") == AgentState.ERROR
        
    def test_claude_detection(self):
        detector = StateDetector()
        
        # Idle
        assert detector.detect("claude", "user@host:~$ ") == AgentState.IDLE
        assert detector.detect("claude", "\n> ") == AgentState.IDLE
        
        # Working
        assert detector.detect("claude", "Reading file...") == AgentState.WORKING
        assert detector.detect("claude", "⠋") == AgentState.WORKING
        
        # Waiting
        assert detector.detect("claude", "Allow this action? [Y/n]") == AgentState.WAITING
        
        # Error
        assert detector.detect("claude", "Command failed") == AgentState.ERROR

    def test_unknown_agent(self):
        detector = StateDetector()
        assert detector.detect("unknown_agent", "Thinking...") == AgentState.UNKNOWN

    def test_priority(self):
        """Ensure Error > Waiting > Working > Idle"""
        detector = StateDetector()
        # Mixed output: Error should take precedence over Working
        output = "Thinking...\nError: Connection failed"
        assert detector.detect("gemini", output) == AgentState.ERROR
        
        # Waiting > Working
        output = "Thinking...\nConfirm? [y/N]"
        assert detector.detect("gemini", output) == AgentState.WAITING

    def test_stuck_detection(self):
        detector = StateDetector()
        output = "Thinking..."
        assert detector.detect("gemini", output) == AgentState.WORKING

        detector.history["gemini"]["last_change"] = time.time() - 301
        assert detector.detect("gemini", output) == AgentState.STUCK

    def test_stale_detection(self):
        detector = StateDetector()
        output = "> "
        assert detector.detect("gemini", output) == AgentState.IDLE

        detector.history["gemini"]["last_change"] = time.time() - 601
        assert detector.detect("gemini", output) == AgentState.STALE

    def test_loop_detection(self):
        detector = StateDetector()
        output = "\n".join(["Reading"] * 5)
        assert detector.detect("claude", output) == AgentState.STUCK

    def test_kimi_idle_not_false_working(self):
        """Kimi status bar 'agent (kimi-k2.5, thinking)' must NOT trigger WORKING."""
        detector = StateDetector()
        kimi_idle = "agent (kimi-k2.5, thinking)\ncontext: 0.0%\noperator@zeos\n> "
        assert detector.detect("kimi", kimi_idle) == AgentState.IDLE

    def test_kimi_active_thinking(self):
        """Kimi spinner + Thinking must trigger WORKING."""
        detector = StateDetector()
        kimi_working = "⠼ Thinking about the problem..."
        assert detector.detect("kimi", kimi_working) == AgentState.WORKING
