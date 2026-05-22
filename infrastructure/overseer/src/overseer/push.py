"""
Clawdbot Push Client for native push events.

Enables real-time event delivery to external systems (e.g., Clawdbot gateway)
instead of relying solely on polling.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)


@dataclass
class PushEvent:
    """Event payload for push notifications."""
    event: str                           # Event type (e.g., "task_complete", "heartbeat")
    data: Dict[str, Any]                 # Event-specific data
    session: str                         # Source session/agent identifier
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class PushResult:
    """Result of a push operation."""
    success: bool
    error: Optional[str] = None
    status_code: Optional[int] = None
    response_data: Optional[Dict[str, Any]] = None


class ClawdbotPushClient:
    """
    HTTP client for pushing events to Clawdbot gateway.

    Usage:
        client = ClawdbotPushClient(
            gateway_url="https://clawdbot.example.com/events",
            token="Bearer xyz..."
        )
        result = client.push(PushEvent(
            event="task_complete",
            data={"task_id": "T1", "status": "success"},
            session="claude-3"
        ))
    """

    DEFAULT_TIMEOUT = 5  # seconds

    def __init__(self, gateway_url: str, token: str, timeout: int = DEFAULT_TIMEOUT):
        """
        Initialize push client.

        Args:
            gateway_url: Full URL to Clawdbot gateway endpoint
            token: Bearer token for authorization
            timeout: Request timeout in seconds (default 5)
        """
        self.gateway_url = gateway_url
        self.token = token
        self.timeout = timeout

    def push(self, event: PushEvent) -> PushResult:
        """
        Push an event to the Clawdbot gateway.

        Args:
            event: PushEvent to send

        Returns:
            PushResult with success status and any error details
        """
        if not self.gateway_url:
            return PushResult(
                success=False,
                error="Gateway URL not configured"
            )

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}" if self.token else ""
        }

        payload = {
            "event": event.event,
            "data": event.data,
            "session": event.session,
            "timestamp": event.timestamp
        }

        try:
            response = requests.post(
                self.gateway_url,
                json=payload,
                headers=headers,
                timeout=self.timeout
            )

            if response.ok:
                return PushResult(
                    success=True,
                    status_code=response.status_code,
                    response_data=response.json() if response.text else None
                )
            else:
                return PushResult(
                    success=False,
                    error=f"HTTP {response.status_code}: {response.text[:200]}",
                    status_code=response.status_code
                )

        except requests.exceptions.Timeout:
            logger.warning(f"Push timeout to {self.gateway_url}")
            return PushResult(
                success=False,
                error=f"Request timeout after {self.timeout}s"
            )
        except requests.exceptions.ConnectionError as e:
            logger.warning(f"Push connection error to {self.gateway_url}: {e}")
            return PushResult(
                success=False,
                error=f"Connection error: {str(e)[:100]}"
            )
        except Exception as e:
            logger.error(f"Unexpected push error: {e}")
            return PushResult(
                success=False,
                error=f"Unexpected error: {str(e)[:100]}"
            )
