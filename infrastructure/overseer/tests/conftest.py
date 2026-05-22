"""
Shared test fixtures for Overseer test suite.
"""
import pytest

import overseer.server as _server_mod
import overseer.tmux_backend as _tmux_mod


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Reset the global rate limiter before each test to prevent cross-test exhaustion."""
    from overseer.server import _rate_limiter
    _rate_limiter.buckets.clear()
    yield
    _rate_limiter.buckets.clear()


@pytest.fixture(autouse=True)
def reset_db_initialized():
    """Reset _db_initialized_path before each test so init_db() runs for each test's temp DB."""
    _server_mod._db_initialized_path = None
    _server_mod._wal_initialized = False
    yield
    _server_mod._db_initialized_path = None
    _server_mod._wal_initialized = False


@pytest.fixture(autouse=True)
def reset_tmux_backend():
    """Reset TmuxBackend singleton before each test for clean isolation."""
    _tmux_mod._backend = None
    yield
    _tmux_mod._backend = None


@pytest.fixture(autouse=True)
def reset_heartbeat_registry():
    """Reset in-memory heartbeat registry between tests for isolation."""
    _server_mod._heartbeat_registry.clear()
    yield
    _server_mod._heartbeat_registry.clear()
