"""
Context Summarization Module (P1-2).

Provides rule-based summarization for task context compression.
Reduces token usage by extracting key information from task messages.
"""

import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import List, Dict, Any, Optional

# Maximum summary length in characters
MAX_SUMMARY_LENGTH = 200


@dataclass
class TaskSummary:
    """Summary of a completed task."""
    task_id: str
    worker: Optional[str]
    outcome: str  # success, failed, blocked
    duration_seconds: Optional[int]
    summary_text: str
    compressed_tokens: int  # Estimated tokens saved


class TaskSummarizer:
    """
    Rule-based task context summarizer.

    Extracts key information from task-related messages:
    - Task ID and assignment
    - Worker identity
    - Outcome (complete, blocked, failed)
    - Duration
    - Key artifacts

    Example:
        summarizer = TaskSummarizer()
        messages = [...task messages...]
        summary = summarizer.summarize(messages)
    """

    def __init__(self, max_length: int = MAX_SUMMARY_LENGTH):
        """
        Initialize summarizer.

        Args:
            max_length: Maximum summary length in characters
        """
        self.max_length = max_length

    def summarize(self, messages: List[Dict[str, Any]]) -> str:
        """
        Generate a summary from task messages.

        Args:
            messages: List of relay messages related to a task

        Returns:
            Compressed summary string (max MAX_SUMMARY_LENGTH chars)
        """
        if not messages:
            return ""

        # Extract key information
        task_id = self._extract_task_id(messages)
        worker = self._extract_worker(messages)
        outcome = self._extract_outcome(messages)
        duration = self._calculate_duration(messages)
        artifacts = self._extract_artifacts(messages)

        # Build summary
        parts = []

        if task_id:
            parts.append(f"Task {task_id}")

        if worker:
            parts.append(f"by {worker}")

        if outcome:
            parts.append(f"-> {outcome}")

        if duration:
            parts.append(f"({self._format_duration(duration)})")

        if artifacts:
            parts.append(f"[{len(artifacts)} artifact(s)]")

        summary = " ".join(parts)

        # Truncate if needed
        if len(summary) > self.max_length:
            summary = summary[:self.max_length - 3] + "..."

        return summary

    def summarize_full(self, messages: List[Dict[str, Any]]) -> TaskSummary:
        """
        Generate a full TaskSummary object.

        Args:
            messages: List of relay messages

        Returns:
            TaskSummary dataclass with all extracted information
        """
        task_id = self._extract_task_id(messages) or "unknown"
        worker = self._extract_worker(messages)
        outcome = self._extract_outcome(messages) or "unknown"
        duration = self._calculate_duration(messages)
        summary_text = self.summarize(messages)

        # Estimate token savings
        original_chars = sum(len(m.get("content", "")) for m in messages)
        compressed_tokens = max(0, (original_chars - len(summary_text)) // 4)

        return TaskSummary(
            task_id=task_id,
            worker=worker,
            outcome=outcome,
            duration_seconds=duration,
            summary_text=summary_text,
            compressed_tokens=compressed_tokens
        )

    def _extract_task_id(self, messages: List[Dict[str, Any]]) -> Optional[str]:
        """Extract task_id from messages."""
        for msg in messages:
            content = msg.get("content", "")
            try:
                data = json.loads(content)
                if "task_id" in data:
                    return data["task_id"]
            except (json.JSONDecodeError, TypeError):
                # Try regex fallback
                match = re.search(r'"task_id":\s*"([^"]+)"', content)
                if match:
                    return match.group(1)
        return None

    def _extract_worker(self, messages: List[Dict[str, Any]]) -> Optional[str]:
        """Extract worker from task_assign message."""
        for msg in messages:
            if msg.get("type") == "task_assign":
                content = msg.get("content", "")
                try:
                    data = json.loads(content)
                    return data.get("assigned_to")
                except (json.JSONDecodeError, TypeError):
                    pass
            # Also check agent field for task_accept
            if msg.get("type") == "task_accept":
                return msg.get("agent")
        return None

    def _extract_outcome(self, messages: List[Dict[str, Any]]) -> Optional[str]:
        """Extract outcome from task_complete or task_blocked."""
        for msg in reversed(messages):  # Check latest first
            msg_type = msg.get("type")
            if msg_type == "task_complete":
                content = msg.get("content", "")
                try:
                    data = json.loads(content)
                    return data.get("status", "success")
                except (json.JSONDecodeError, TypeError):
                    return "success"
            elif msg_type == "task_blocked":
                return "blocked"
        return None

    def _calculate_duration(self, messages: List[Dict[str, Any]]) -> Optional[int]:
        """Calculate duration from first to last message timestamp."""
        if len(messages) < 2:
            return None

        try:
            timestamps = []
            for msg in messages:
                ts = msg.get("timestamp")
                if ts:
                    # Handle ISO format
                    if isinstance(ts, str):
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        timestamps.append(dt)

            if len(timestamps) >= 2:
                timestamps.sort()
                duration = (timestamps[-1] - timestamps[0]).total_seconds()
                return int(duration)
        except (ValueError, TypeError):
            pass

        return None

    def _extract_artifacts(self, messages: List[Dict[str, Any]]) -> List[str]:
        """Extract artifact paths from messages."""
        artifacts = []
        for msg in messages:
            content = msg.get("content", "")
            try:
                data = json.loads(content)
                if "artifacts" in data and isinstance(data["artifacts"], list):
                    artifacts.extend(data["artifacts"])
            except (json.JSONDecodeError, TypeError):
                pass
        return artifacts

    def _format_duration(self, seconds: int) -> str:
        """Format duration as human-readable string."""
        if seconds < 60:
            return f"{seconds}s"
        elif seconds < 3600:
            return f"{seconds // 60}m {seconds % 60}s"
        else:
            hours = seconds // 3600
            mins = (seconds % 3600) // 60
            return f"{hours}h {mins}m"
