"""
Tests for Native RPC Module (P1-3).
"""

import pytest
import socket
import threading
import time
from unittest.mock import patch, MagicMock

from overseer.rpc import RPCRequest, RPCResponse, AgentRPCServer, AgentRPCClient


class TestRPCTypes:
    """Test RPC protocol types."""

    def test_rpc_request_creation(self):
        """Test RPCRequest dataclass creation."""
        req = RPCRequest(method="execute", params={"command": "ls"})
        assert req.method == "execute"
        assert req.params == {"command": "ls"}
        assert req.request_id == ""
        assert req.sender == ""
        assert req.timestamp  # Should have default timestamp

    def test_rpc_request_json_roundtrip(self):
        """Test RPCRequest JSON serialization."""
        req = RPCRequest(
            method="test",
            params={"key": "value"},
            request_id="123",
            sender="claude-3"
        )
        json_str = req.to_json()
        req2 = RPCRequest.from_json(json_str)
        assert req2.method == req.method
        assert req2.params == req.params
        assert req2.request_id == req.request_id
        assert req2.sender == req.sender

    def test_rpc_response_creation(self):
        """Test RPCResponse dataclass creation."""
        resp = RPCResponse(request_id="123", result={"status": "ok"})
        assert resp.request_id == "123"
        assert resp.result == {"status": "ok"}
        assert resp.error is None

    def test_rpc_response_with_error(self):
        """Test RPCResponse with error."""
        resp = RPCResponse(request_id="123", error="Something failed")
        assert resp.request_id == "123"
        assert resp.result is None
        assert resp.error == "Something failed"

    def test_rpc_response_json_roundtrip(self):
        """Test RPCResponse JSON serialization."""
        resp = RPCResponse(request_id="456", result={"data": [1, 2, 3]})
        json_str = resp.to_json()
        resp2 = RPCResponse.from_json(json_str)
        assert resp2.request_id == resp.request_id
        assert resp2.result == resp.result


class TestAgentRPCServer:
    """Test AgentRPCServer class."""

    def test_server_creation(self):
        """Test server instantiation."""
        server = AgentRPCServer(port=19099)
        assert server.port == 19099
        assert server.host == "0.0.0.0"
        assert server.handlers == {}

    def test_server_custom_host(self):
        """Test server with custom host."""
        server = AgentRPCServer(port=19099, host="127.0.0.1")
        assert server.host == "127.0.0.1"

    def test_register_handler(self):
        """Test registering handlers."""
        server = AgentRPCServer(port=19099)

        def my_handler(arg1):
            return {"result": arg1}

        server.register_handler("my_method", my_handler)
        assert "my_method" in server.handlers
        assert server.handlers["my_method"] == my_handler

    def test_server_start_stop_nonblocking(self):
        """Test non-blocking server start/stop."""
        server = AgentRPCServer(port=19098)
        server.start(blocking=False)
        time.sleep(0.1)  # Give server time to start
        assert server._running
        server.stop()
        assert not server._running

    def test_server_dispatch_unknown_method(self):
        """Test dispatch with unknown method."""
        server = AgentRPCServer(port=19097)
        req = RPCRequest(method="unknown", request_id="test123")
        resp = server._dispatch(req)
        assert resp.error == "Unknown method: unknown"
        assert resp.request_id == "test123"

    def test_server_dispatch_valid_method(self):
        """Test dispatch with valid method."""
        server = AgentRPCServer(port=19096)
        server.register_handler("ping", lambda: {"status": "pong"})
        req = RPCRequest(method="ping", request_id="test456")
        resp = server._dispatch(req)
        assert resp.result == {"status": "pong"}
        assert resp.error is None

    def test_server_dispatch_handler_exception(self):
        """Test dispatch when handler raises exception."""
        server = AgentRPCServer(port=19095)

        def bad_handler():
            raise ValueError("Handler error")

        server.register_handler("bad", bad_handler)
        req = RPCRequest(method="bad", request_id="test789")
        resp = server._dispatch(req)
        assert "Handler error" in resp.error


class TestAgentRPCClient:
    """Test AgentRPCClient class."""

    def test_client_creation(self):
        """Test client instantiation."""
        client = AgentRPCClient("127.0.0.1", 19003)
        assert client.host == "127.0.0.1"
        assert client.port == 19003
        assert client.timeout == 30.0

    def test_client_custom_timeout(self):
        """Test client with custom timeout."""
        client = AgentRPCClient("localhost", 19004, timeout=60.0)
        assert client.timeout == 60.0

    def test_client_connection_refused(self):
        """Test client when server not running."""
        client = AgentRPCClient("127.0.0.1", 19999)  # Unlikely port
        resp = client.call("test", {})
        assert resp.error is not None
        assert "Connection refused" in resp.error

    def test_client_server_roundtrip(self):
        """Test full client-server communication."""
        # Start server
        server = AgentRPCServer(port=19094, host="127.0.0.1")
        server.register_handler("echo", lambda message: {"echo": message})
        server.start(blocking=False)
        time.sleep(0.1)

        try:
            # Call from client
            client = AgentRPCClient("127.0.0.1", 19094)
            resp = client.call("echo", {"message": "hello"}, sender="test-client")
            assert resp.error is None
            assert resp.result == {"echo": "hello"}
        finally:
            server.stop()


# Blueprint verification wrapper tests
def test_server():
    """Blueprint verification: P1-3.2 - AgentRPCServer works."""
    server = AgentRPCServer(port=19091)
    server.register_handler("ping", lambda: {"status": "pong"})
    assert "ping" in server.handlers
    # Test dispatch
    req = RPCRequest(method="ping", request_id="verify")
    resp = server._dispatch(req)
    assert resp.result == {"status": "pong"}


def test_client():
    """Blueprint verification: P1-3.3 - AgentRPCClient works."""
    client = AgentRPCClient("127.0.0.1", 19003)
    assert client.host == "127.0.0.1"
    assert client.port == 19003
    # Test connection refused (no server running)
    resp = client.call("test", {})
    assert resp.error is not None  # Should fail gracefully


def test_execute_tool():
    """Blueprint verification: P1-3.4 - execute_on_agent MCP tool exists."""
    from overseer.server import execute_on_agent
    # Just verify the function exists and is callable
    assert callable(execute_on_agent)
