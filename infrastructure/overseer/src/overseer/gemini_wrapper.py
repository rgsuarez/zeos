"""
Gemini Auto-Approval Wrapper (P0-3).

Monitors a Gemini CLI tmux session and auto-approves MCP tool calls
based on an allowlist. Prevents workflow stalls from approval prompts.
"""

import logging
import re
import signal
import subprocess
import time
from typing import List, Optional, Set

from overseer.tmux_backend import get_backend as get_tmux_backend

logger = logging.getLogger(__name__)

# Approval prompt detection regex (P0-3.3)
# Matches patterns like:
# - "Allow overseer:get_messages? (y/N)"
# - "Allow mcp:tool_name? [y/N]"
# - "Tool call: overseer:dispatch_task - Allow? (y/n)"
APPROVAL_PATTERN = re.compile(
    r"(?:Allow|approve|permit)\s+(?:[\w-]+:)?([\w_-]+)\??\s*[\[(]?[yYnN]/[yYnN][\])]?",
    re.IGNORECASE
)


class GeminiAutoApprover:
    """
    Auto-approve MCP tool calls in a Gemini CLI tmux session.

    Usage:
        approver = GeminiAutoApprover(
            tmux_session="gemini-3",
            tool_allowlist=["get_messages", "post_message", "dispatch_task"]
        )
        approver.start()  # Blocks until stopped
    """

    DEFAULT_POLL_INTERVAL = 0.5  # seconds
    CAPTURE_LINES = 30  # Lines to capture for prompt detection

    def __init__(
        self,
        tmux_session: str,
        tool_allowlist: List[str],
        poll_interval: float = DEFAULT_POLL_INTERVAL
    ):
        """
        Initialize auto-approver.

        Args:
            tmux_session: tmux session name to monitor (e.g., "gemini-3")
            tool_allowlist: List of tool names to auto-approve
            poll_interval: Seconds between pane captures (default 0.5)
        """
        self.tmux_session = tmux_session
        self.tool_allowlist: Set[str] = set(tool_allowlist)
        self.poll_interval = poll_interval
        self._running = False
        self._shutdown_requested = False

    def _capture_pane(self, lines: int = CAPTURE_LINES) -> str:
        """
        Capture recent terminal output from tmux session.

        Args:
            lines: Number of lines to capture

        Returns:
            Terminal output as string, or empty string on error
        """
        output = get_tmux_backend().capture_output(self.tmux_session, lines=lines)
        if output.startswith("Error:"):
            logger.debug(f"tmux capture failed: {output}")
            return ""
        return output

    def _detect_approval_prompt(self, output: str) -> Optional[str]:
        """
        Detect if output contains an approval prompt.

        Args:
            output: Terminal output to scan

        Returns:
            Tool name if prompt detected, None otherwise
        """
        # Check last few lines for prompt
        lines = output.strip().split('\n')
        for line in lines[-5:]:  # Check last 5 lines
            match = APPROVAL_PATTERN.search(line)
            if match:
                tool_name = match.group(1)
                logger.debug(f"Detected approval prompt for: {tool_name}")
                return tool_name
        return None

    def _send_approval(self, tool_name: str) -> bool:
        """
        Send 'y' approval to tmux session.

        Args:
            tool_name: Name of tool being approved (for logging)

        Returns:
            True if sent successfully, False otherwise
        """
        # Check allowlist first
        if tool_name not in self.tool_allowlist:
            logger.info(f"Tool '{tool_name}' not in allowlist, skipping approval")
            return False

        try:
            # Send 'y' followed by Enter (C-m)
            result = get_tmux_backend().send_keys(self.tmux_session, "y", "C-m")
            if result.returncode == 0:
                logger.info(f"Auto-approved tool: {tool_name}")
                return True
            else:
                logger.error(f"Failed to send approval: {result.stderr.decode()}")
                return False
        except subprocess.TimeoutExpired:
            logger.error("Timeout sending approval")
            return False
        except FileNotFoundError:
            logger.error("tmux not found")
            return False

    def _handle_signal(self, signum, frame):
        """Handle SIGTERM/SIGINT for graceful shutdown."""
        logger.info(f"Received signal {signum}, shutting down...")
        self._shutdown_requested = True

    def start(self):
        """
        Start the auto-approval monitoring loop.

        Blocks until stop() is called or SIGTERM received.
        """
        # Setup signal handlers
        signal.signal(signal.SIGTERM, self._handle_signal)
        signal.signal(signal.SIGINT, self._handle_signal)

        self._running = True
        self._shutdown_requested = False

        logger.info(f"Starting auto-approver for {self.tmux_session}")
        logger.info(f"Allowlist: {', '.join(sorted(self.tool_allowlist))}")

        while self._running and not self._shutdown_requested:
            try:
                # Capture pane output
                output = self._capture_pane()
                if not output:
                    time.sleep(self.poll_interval)
                    continue

                # Check for approval prompt
                tool_name = self._detect_approval_prompt(output)
                if tool_name:
                    self._send_approval(tool_name)
                    # Brief pause to avoid double-approval
                    time.sleep(0.1)

                time.sleep(self.poll_interval)

            except Exception as e:
                logger.error(f"Error in monitoring loop: {e}")
                time.sleep(self.poll_interval)

        logger.info("Auto-approver stopped")

    def stop(self):
        """Request graceful shutdown of the monitoring loop."""
        self._running = False
        self._shutdown_requested = True
