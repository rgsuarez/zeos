"""
Unit tests for Gemini auto-approval (P0-3).

Tests:
- GeminiAutoApprover class initialization
- Pane capture functionality
- Approval prompt regex detection
- Send approval via tmux
- Main loop control
"""

import pytest
from unittest.mock import patch, MagicMock
import subprocess

from overseer.gemini_wrapper import GeminiAutoApprover, APPROVAL_PATTERN


class TestCapture:
    """Test _capture_pane() functionality."""

    def test_capture_pane_success(self):
        """Test successful pane capture."""
        approver = GeminiAutoApprover("test-session", [])

        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="Line 1\nLine 2\nAllow overseer:get_messages? (y/N)"
            )

            result = approver._capture_pane()

            assert "get_messages" in result
            # resolve_target probes has-session first, then capture-pane follows
            assert mock_run.call_count >= 1

    def test_capture_pane_session_not_found(self):
        """Test capture when session doesn't exist."""
        approver = GeminiAutoApprover("nonexistent", [])

        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(
                returncode=1,
                stderr="can't find session"
            )

            result = approver._capture_pane()

            assert result == ""

    def test_capture_pane_timeout(self):
        """Test capture timeout handling."""
        approver = GeminiAutoApprover("test", [])

        with patch('subprocess.run') as mock_run:
            mock_run.side_effect = subprocess.TimeoutExpired("cmd", 5)

            result = approver._capture_pane()

            assert result == ""


class TestRegex:
    """Test approval prompt regex detection."""

    def test_detect_standard_format(self):
        """Test detection of standard approval format."""
        output = "Some output\nAllow overseer:get_messages? (y/N)"
        approver = GeminiAutoApprover("test", [])

        result = approver._detect_approval_prompt(output)

        assert result == "get_messages"

    def test_detect_alternative_format(self):
        """Test detection of alternative formats."""
        approver = GeminiAutoApprover("test", [])

        # Different bracket styles
        assert approver._detect_approval_prompt("Allow tool:dispatch_task? [y/N]") == "dispatch_task"
        assert approver._detect_approval_prompt("Allow post_message? (Y/n)") == "post_message"

    def test_no_prompt_detected(self):
        """Test when no prompt is present."""
        approver = GeminiAutoApprover("test", [])

        result = approver._detect_approval_prompt("Regular output\nNo prompts here")

        assert result is None

    def test_prompt_in_middle_of_output(self):
        """Test prompt detection only in last lines."""
        approver = GeminiAutoApprover("test", [])

        # Prompt at top (old) should not be detected
        output = "Allow old_tool? (y/N)\n" + "\n" * 10 + "Current output"
        result = approver._detect_approval_prompt(output)

        assert result is None


class TestSend:
    """Test _send_approval() functionality."""

    def test_send_approval_allowed(self):
        """Test sending approval for allowed tool."""
        approver = GeminiAutoApprover("test", ["get_messages"])

        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(returncode=0)

            result = approver._send_approval("get_messages")

            assert result is True
            # resolve_target probes has-session first, then send-keys follows
            send_keys_calls = [c for c in mock_run.call_args_list
                               if c[0][0][1] == "send-keys"]
            assert len(send_keys_calls) == 1
            call_args = send_keys_calls[0][0][0]
            assert "y" in call_args
            assert "C-m" in call_args

    def test_send_approval_not_allowed(self):
        """Test that non-allowlisted tools are not approved."""
        approver = GeminiAutoApprover("test", ["get_messages"])

        with patch('subprocess.run') as mock_run:
            result = approver._send_approval("dangerous_tool")

            assert result is False
            mock_run.assert_not_called()

    def test_send_approval_failure(self):
        """Test handling of send failure."""
        from overseer.tmux_backend import AgentEntry

        approver = GeminiAutoApprover("test", ["tool"])

        # Patch resolve_entry (the new socket-aware resolver) so send_keys
        # bypasses the multi-socket discovery and exercises only the
        # send-keys-fails path we're testing.
        with patch('subprocess.run') as mock_run, \
             patch(
                 'overseer.tmux_backend.TmuxBackend.resolve_entry',
                 return_value=AgentEntry(
                     name="test", target="test", kind="session", socket="default",
                 ),
             ):
            mock_run.return_value = MagicMock(
                returncode=1,
                stderr=b"error"
            )

            result = approver._send_approval("tool")

            assert result is False


class TestLoop:
    """Test main monitoring loop."""

    def test_stop_flag(self):
        """Test that stop() sets shutdown flag."""
        approver = GeminiAutoApprover("test", [])

        assert approver._shutdown_requested is False

        approver.stop()

        assert approver._shutdown_requested is True

    def test_initialization(self):
        """Test approver initialization."""
        approver = GeminiAutoApprover(
            tmux_session="gemini-3",
            tool_allowlist=["tool1", "tool2"],
            poll_interval=1.0
        )

        assert approver.tmux_session == "gemini-3"
        assert "tool1" in approver.tool_allowlist
        assert "tool2" in approver.tool_allowlist
        assert approver.poll_interval == 1.0

    def test_empty_allowlist(self):
        """Test with empty allowlist."""
        approver = GeminiAutoApprover("test", [])

        assert len(approver.tool_allowlist) == 0

        # Should not approve anything
        with patch('subprocess.run'):
            result = approver._send_approval("any_tool")
            assert result is False


# Blueprint verification wrapper tests
def test_capture():
    """Blueprint verification: P0-3.2 - tmux pane capture monitoring."""
    from overseer.gemini_wrapper import GeminiAutoApprover

    approver = GeminiAutoApprover("test-session", [])

    with patch('subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="Test output\nAllow tool? (y/N)"
        )
        result = approver._capture_pane()
        assert "Test output" in result


def test_regex():
    """Blueprint verification: P0-3.3 - approval prompt detection regex."""
    from overseer.gemini_wrapper import GeminiAutoApprover

    approver = GeminiAutoApprover("test", [])

    # Should detect prompt
    result = approver._detect_approval_prompt("Allow overseer:get_messages? (y/N)")
    assert result == "get_messages"

    # Should not detect when no prompt
    result = approver._detect_approval_prompt("No prompts here")
    assert result is None


def test_send():
    """Blueprint verification: P0-3.4 - auto-response via tmux send-keys."""
    from overseer.gemini_wrapper import GeminiAutoApprover

    approver = GeminiAutoApprover("test", ["allowed_tool"])

    with patch('subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(returncode=0)

        # Allowed tool should be approved
        result = approver._send_approval("allowed_tool")
        assert result is True

        # Non-allowed tool should not be approved
        result = approver._send_approval("forbidden_tool")
        assert result is False


def test_loop():
    """Blueprint verification: P0-3.5 - main loop with signal handling."""
    from overseer.gemini_wrapper import GeminiAutoApprover

    approver = GeminiAutoApprover("test", [])

    # Stop flag should work
    assert approver._shutdown_requested is False
    approver.stop()
    assert approver._shutdown_requested is True


class TestApprovalPattern:
    """Test APPROVAL_PATTERN regex directly."""

    def test_pattern_matches_standard(self):
        """Test standard approval patterns."""
        import re

        assert re.search(APPROVAL_PATTERN, "Allow overseer:get_messages? (y/N)")
        assert re.search(APPROVAL_PATTERN, "Allow mcp:tool_name? [y/N]")
        assert re.search(APPROVAL_PATTERN, "approve dispatch_task? (Y/n)")

    def test_pattern_extracts_tool_name(self):
        """Test that pattern extracts correct tool name."""
        import re

        match = re.search(APPROVAL_PATTERN, "Allow overseer:get_messages? (y/N)")
        assert match.group(1) == "get_messages"

        match = re.search(APPROVAL_PATTERN, "Allow post_message? (y/N)")
        assert match.group(1) == "post_message"

    def test_pattern_case_insensitive(self):
        """Test case insensitivity."""
        import re

        assert re.search(APPROVAL_PATTERN, "ALLOW tool_name? (Y/N)")
        assert re.search(APPROVAL_PATTERN, "Approve TOOL? (y/n)")
