"""
Unit tests for push events (P0-1.5).

Tests:
- ClawdbotPushClient success/failure scenarios
- post_message with push_to_clawdbot integration
- Graceful degradation when push fails
"""

import json
import pytest
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
from unittest.mock import patch, MagicMock

from overseer.push import ClawdbotPushClient, PushEvent, PushResult


class MockGatewayHandler(BaseHTTPRequestHandler):
    """Mock HTTP handler for gateway tests."""

    def log_message(self, format, *args):
        pass  # Suppress logging

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        data = json.loads(body) if body else {}

        # Store received data for assertions
        MockGatewayHandler.last_request = {
            "path": self.path,
            "headers": dict(self.headers),
            "body": data
        }

        # Return based on test mode
        if getattr(MockGatewayHandler, 'return_error', False):
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{"error": "Internal Server Error"}')
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "received"}).encode())


class TestPushClient:
    """Test ClawdbotPushClient."""

    def test_push_client_success(self):
        """Test successful push to gateway."""
        # Start mock server
        MockGatewayHandler.return_error = False
        server = HTTPServer(('127.0.0.1', 0), MockGatewayHandler)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request)
        thread.start()

        try:
            client = ClawdbotPushClient(
                gateway_url=f"http://127.0.0.1:{port}/events",
                token="test-token"
            )

            event = PushEvent(
                event="task_complete",
                data={"task_id": "T1", "status": "success"},
                session="claude-3"
            )

            result = client.push(event)

            assert result.success is True
            assert result.status_code == 200

            # Verify request was received correctly
            assert MockGatewayHandler.last_request["body"]["event"] == "task_complete"
            assert MockGatewayHandler.last_request["body"]["session"] == "claude-3"
            assert "Bearer test-token" in MockGatewayHandler.last_request["headers"].get("Authorization", "")

        finally:
            thread.join(timeout=2)
            server.server_close()

    def test_push_client_failure(self):
        """Test push failure handling (connection error)."""
        client = ClawdbotPushClient(
            gateway_url="http://127.0.0.1:59999/nonexistent",
            token="test-token",
            timeout=1
        )

        event = PushEvent(
            event="heartbeat",
            data={"progress": 50},
            session="claude-3"
        )

        result = client.push(event)

        assert result.success is False
        assert result.error is not None
        assert "Connection error" in result.error or "timeout" in result.error.lower()

    def test_push_client_no_url(self):
        """Test push with empty gateway URL."""
        client = ClawdbotPushClient(gateway_url="", token="")

        event = PushEvent(
            event="test",
            data={},
            session="test"
        )

        result = client.push(event)

        assert result.success is False
        assert "not configured" in result.error


class TestPostMessagePush:
    """Test post_message with push_to_clawdbot parameter."""

    def test_post_message_push_disabled(self):
        """Test post_message without push (default behavior)."""
        from overseer.server import post_message, init_db

        init_db()
        result = post_message(
            agent="claude-3",
            content="test message",
            msg_type="raw",
            push_to_clawdbot=False
        )

        assert result["status"] == "posted"
        assert "push_status" not in result  # No push attempted

    def test_post_message_push_no_client(self):
        """Test post_message with push but no client configured."""
        from overseer.server import post_message, init_db

        # Ensure no gateway URL configured
        with patch('overseer.server.CLAWDBOT_GATEWAY_URL', ''):
            with patch('overseer.server._push_client', None):
                init_db()
                result = post_message(
                    agent="claude-3",
                    content="test message",
                    msg_type="raw",
                    push_to_clawdbot=True
                )

                assert result["status"] == "posted"
                assert result.get("push_status") == "skipped"

    def test_post_message_push_success(self):
        """Test post_message with successful push."""
        from overseer.server import post_message, init_db, get_push_client

        # Mock successful push
        mock_client = MagicMock()
        mock_client.push.return_value = PushResult(success=True, status_code=200)

        with patch('overseer.server.get_push_client', return_value=mock_client):
            init_db()
            result = post_message(
                agent="claude-3",
                content='{"task_id": "T1"}',
                msg_type="task_complete",
                push_to_clawdbot=True
            )

            assert result["status"] == "posted"
            assert result.get("push_status") == "success"
            mock_client.push.assert_called_once()

    def test_push_graceful_degradation(self):
        """Test that relay write succeeds even when push fails."""
        from overseer.server import post_message, init_db

        # Mock failed push
        mock_client = MagicMock()
        mock_client.push.return_value = PushResult(
            success=False,
            error="Gateway unreachable"
        )

        with patch('overseer.server.get_push_client', return_value=mock_client):
            init_db()
            result = post_message(
                agent="claude-3",
                content="test message",
                msg_type="raw",
                push_to_clawdbot=True
            )

            # Relay write should succeed even though push failed
            assert result["status"] == "posted"
            assert result["id"] is not None
            assert result.get("push_status") == "failed"
            assert "Gateway unreachable" in result.get("push_error", "")


# Blueprint verification wrapper tests
def test_push_client():
    """Blueprint verification: P0-1.2 - ClawdbotPushClient.push() works."""
    from overseer.push import ClawdbotPushClient, PushEvent

    # Test with no URL configured (graceful failure)
    client = ClawdbotPushClient(gateway_url="", token="")
    event = PushEvent(event="test", data={}, session="test")
    result = client.push(event)
    assert result.success is False
    assert "not configured" in result.error


def test_post_message_push():
    """Blueprint verification: P0-1.4 - post_message with push parameter."""
    from overseer.server import post_message, init_db

    init_db()
    result = post_message(
        agent="claude-3",
        content="test message",
        msg_type="raw",
        push_to_clawdbot=False
    )
    assert result["status"] == "posted"


class TestIntegrationMockGateway:
    """Integration test with mock gateway."""

    def test_integration_mock_gateway(self):
        """Full integration test with actual HTTP mock."""
        from overseer.server import post_message, init_db
        from overseer.push import ClawdbotPushClient

        # Start mock server
        MockGatewayHandler.return_error = False
        server = HTTPServer(('127.0.0.1', 0), MockGatewayHandler)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request)
        thread.start()

        try:
            # Create real client pointing to mock
            mock_client = ClawdbotPushClient(
                gateway_url=f"http://127.0.0.1:{port}/events",
                token="integration-test-token"
            )

            with patch('overseer.server.get_push_client', return_value=mock_client):
                init_db()
                result = post_message(
                    agent="claude-3",
                    content='{"task_id": "INT-1", "result": "success"}',
                    msg_type="task_complete",
                    push_to_clawdbot=True
                )

                assert result["status"] == "posted"
                assert result.get("push_status") == "success"

                # Verify gateway received correct payload
                assert MockGatewayHandler.last_request["body"]["event"] == "task_complete"
                assert MockGatewayHandler.last_request["body"]["data"]["task_id"] == "INT-1"
                assert MockGatewayHandler.last_request["body"]["session"] == "claude-3"
                assert "Bearer integration-test-token" in MockGatewayHandler.last_request["headers"].get("Authorization", "")

        finally:
            thread.join(timeout=2)
            server.server_close()


# Blueprint verification wrapper for integration test
def test_integration_mock_gateway():
    """Blueprint verification: P0-1.6 - Integration test with mock gateway."""
    from overseer.server import post_message, init_db
    from overseer.push import ClawdbotPushClient, PushResult
    from unittest.mock import patch, MagicMock

    # Mock successful push
    mock_client = MagicMock()
    mock_client.push.return_value = PushResult(success=True, status_code=200)

    with patch('overseer.server.get_push_client', return_value=mock_client):
        init_db()
        result = post_message(
            agent="claude-3",
            content='{"task_id": "VERIFY-INT", "result": "success"}',
            msg_type="task_complete",
            push_to_clawdbot=True
        )

        assert result["status"] == "posted"
        assert result.get("push_status") == "success"
