"""
Native RPC Module for Overseer (P1-3).

Provides direct agent-to-agent RPC communication bypassing relay polling.
"""

import json
import socket
import threading
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional


@dataclass
class RPCRequest:
    """RPC request message."""
    method: str
    params: Dict[str, Any] = field(default_factory=dict)
    request_id: str = ""
    sender: str = ""
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_json(cls, data: str) -> "RPCRequest":
        return cls(**json.loads(data))


@dataclass
class RPCResponse:
    """RPC response message."""
    request_id: str
    result: Any = None
    error: Optional[str] = None
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_json(cls, data: str) -> "RPCResponse":
        return cls(**json.loads(data))


class AgentRPCServer:
    """
    RPC server for receiving commands from other agents.

    Usage:
        server = AgentRPCServer(port=19003)
        server.register_handler("execute", my_execute_func)
        server.start()  # Blocks
    """

    def __init__(self, port: int, host: str = "0.0.0.0"):
        self.port = port
        self.host = host
        self.handlers: Dict[str, Callable] = {}
        self._running = False
        self._socket: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None

    def register_handler(self, method: str, handler: Callable):
        """Register a handler for an RPC method."""
        self.handlers[method] = handler

    def start(self, blocking: bool = True):
        """Start the RPC server."""
        self._running = True
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind((self.host, self.port))
        self._socket.listen(5)
        self._socket.settimeout(1.0)

        if blocking:
            self._serve()
        else:
            self._thread = threading.Thread(target=self._serve, daemon=True)
            self._thread.start()

    def stop(self):
        """Stop the RPC server."""
        self._running = False
        if self._socket:
            self._socket.close()
        if self._thread:
            self._thread.join(timeout=2)

    def _serve(self):
        """Main serving loop."""
        while self._running:
            try:
                conn, addr = self._socket.accept()
                threading.Thread(
                    target=self._handle_connection,
                    args=(conn,),
                    daemon=True
                ).start()
            except socket.timeout:
                continue
            except OSError:
                break

    def _handle_connection(self, conn: socket.socket):
        """Handle a single RPC connection."""
        try:
            conn.settimeout(30.0)
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\n" in data:
                    break

            if data:
                request = RPCRequest.from_json(data.decode().strip())
                response = self._dispatch(request)
                conn.sendall((response.to_json() + "\n").encode())
        except Exception as e:
            error_response = RPCResponse(
                request_id="",
                error=str(e)
            )
            try:
                conn.sendall((error_response.to_json() + "\n").encode())
            except:
                pass
        finally:
            conn.close()

    def _dispatch(self, request: RPCRequest) -> RPCResponse:
        """Dispatch request to registered handler."""
        handler = self.handlers.get(request.method)
        if not handler:
            return RPCResponse(
                request_id=request.request_id,
                error=f"Unknown method: {request.method}"
            )

        try:
            result = handler(**request.params)
            return RPCResponse(
                request_id=request.request_id,
                result=result
            )
        except Exception as e:
            return RPCResponse(
                request_id=request.request_id,
                error=str(e)
            )


class AgentRPCClient:
    """
    RPC client for sending commands to other agents.

    Usage:
        client = AgentRPCClient("127.0.0.1", 19003)
        response = client.call("execute", {"command": "git status"})
    """

    def __init__(self, host: str, port: int, timeout: float = 30.0):
        self.host = host
        self.port = port
        self.timeout = timeout

    def call(self, method: str, params: Dict[str, Any] = None, sender: str = "") -> RPCResponse:
        """
        Make an RPC call to the server.

        Args:
            method: RPC method name
            params: Method parameters
            sender: Caller identifier

        Returns:
            RPCResponse with result or error
        """
        import uuid

        request = RPCRequest(
            method=method,
            params=params or {},
            request_id=str(uuid.uuid4()),
            sender=sender
        )

        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(self.timeout)
            sock.connect((self.host, self.port))

            sock.sendall((request.to_json() + "\n").encode())

            data = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\n" in data:
                    break

            sock.close()

            if data:
                return RPCResponse.from_json(data.decode().strip())
            else:
                return RPCResponse(
                    request_id=request.request_id,
                    error="No response received"
                )

        except socket.timeout:
            return RPCResponse(
                request_id=request.request_id,
                error=f"Connection timeout after {self.timeout}s"
            )
        except ConnectionRefusedError:
            return RPCResponse(
                request_id=request.request_id,
                error=f"Connection refused to {self.host}:{self.port}"
            )
        except Exception as e:
            return RPCResponse(
                request_id=request.request_id,
                error=str(e)
            )
