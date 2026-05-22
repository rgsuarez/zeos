"""
Unit tests for orchestration primitives (P1-3.4).

Tests:
- DispatchPolicy dataclass
- RoutingTable with pattern matching
- route_task helper function
"""

import pytest
from overseer.hive import (
    DispatchPolicy,
    RoutingTable,
    route_task,
    Task,
    TaskPriority,
)


class TestDispatchPolicy:
    """Test DispatchPolicy dataclass."""

    def test_default_policy(self):
        """Test default policy values."""
        policy = DispatchPolicy()

        assert policy.max_retries == 3
        assert policy.timeout_seconds == 300
        assert policy.preferred_workers == []
        assert policy.excluded_workers == []
        assert policy.require_ack is True
        assert policy.ack_timeout_seconds == 30

    def test_custom_policy(self):
        """Test custom policy values."""
        policy = DispatchPolicy(
            max_retries=5,
            timeout_seconds=600,
            preferred_workers=["claude-3"],
            excluded_workers=["slow-worker"],
            require_ack=False
        )

        assert policy.max_retries == 5
        assert policy.timeout_seconds == 600
        assert "claude-3" in policy.preferred_workers
        assert "slow-worker" in policy.excluded_workers

    def test_policy_to_dict(self):
        """Test serialization to dict."""
        policy = DispatchPolicy(max_retries=7)
        data = policy.to_dict()

        assert data["max_retries"] == 7
        assert "timeout_seconds" in data

    def test_policy_from_dict(self):
        """Test deserialization from dict."""
        data = {"max_retries": 10, "timeout_seconds": 120}
        policy = DispatchPolicy.from_dict(data)

        assert policy.max_retries == 10
        assert policy.timeout_seconds == 120


class TestRoutingTable:
    """Test RoutingTable class."""

    def test_empty_routing(self):
        """Test empty routing table."""
        table = RoutingTable()
        workers = table.get_workers("any task")

        assert workers == []

    def test_add_route(self):
        """Test adding routing rules."""
        table = RoutingTable()
        table.add_route("test", ["claude-3", "codex-3"])

        workers = table.get_workers("run tests")
        assert "claude-3" in workers
        assert "codex-3" in workers

    def test_pattern_matching(self):
        """Test regex pattern matching."""
        table = RoutingTable()
        table.add_route(r".*test.*", ["test-runner-3"])
        table.add_route(r".*deploy.*", ["deploy-agent-3"])

        assert "test-runner-3" in table.get_workers("run unit tests")
        assert "deploy-agent-3" in table.get_workers("deploy to production")
        assert table.get_workers("unrelated task") == []

    def test_case_insensitive(self):
        """Test case insensitive pattern matching."""
        table = RoutingTable()
        table.add_route(r"CODE", ["coder-3"])

        workers = table.get_workers("write code for feature")
        assert "coder-3" in workers

    def test_routing_to_dict(self):
        """Test serialization."""
        table = RoutingTable()
        table.add_route("test", ["claude-3"])
        data = table.to_dict()

        assert "routes" in data
        assert "test" in data["routes"]

    def test_routing_from_dict(self):
        """Test deserialization."""
        data = {"routes": {"build": ["builder-3"]}}
        table = RoutingTable.from_dict(data)

        assert "builder-3" in table.get_workers("build project")


class TestRouteTask:
    """Test route_task helper function."""

    def test_route_no_workers(self):
        """Test routing with no available workers."""
        task = Task.create("test task")
        result = route_task(task, [])

        assert result is None

    def test_route_single_worker(self):
        """Test routing with single worker."""
        task = Task.create("test task")
        result = route_task(task, ["claude-3"])

        assert result == "claude-3"

    def test_route_with_exclusions(self):
        """Test routing with excluded workers."""
        task = Task.create("test task")
        policy = DispatchPolicy(excluded_workers=["claude-3"])

        result = route_task(
            task,
            ["claude-3", "codex-3"],
            policy=policy
        )

        assert result == "codex-3"

    def test_route_all_excluded(self):
        """Test routing when all workers excluded."""
        task = Task.create("test task")
        policy = DispatchPolicy(excluded_workers=["claude-3", "codex-3"])

        result = route_task(
            task,
            ["claude-3", "codex-3"],
            policy=policy
        )

        assert result is None

    def test_route_with_preferences(self):
        """Test routing with preferred workers."""
        task = Task.create("test task")
        policy = DispatchPolicy(preferred_workers=["codex-3"])

        result = route_task(
            task,
            ["claude-3", "codex-3", "gemini-3"],
            policy=policy
        )

        assert result == "codex-3"

    def test_route_with_routing_table(self):
        """Test routing with routing table."""
        task = Task.create("run unit tests")
        table = RoutingTable()
        table.add_route(r"test", ["test-specialist-3"])

        result = route_task(
            task,
            ["claude-3", "codex-3", "test-specialist-3"],
            routing_table=table
        )

        assert result == "test-specialist-3"

    def test_route_combined(self):
        """Test routing with all options combined."""
        task = Task.create("run integration tests")

        # Routing table prefers test-runner
        table = RoutingTable()
        table.add_route(r"test", ["test-runner-3", "claude-3"])

        # Policy excludes test-runner
        policy = DispatchPolicy(excluded_workers=["test-runner-3"])

        result = route_task(
            task,
            ["claude-3", "codex-3", "test-runner-3"],
            routing_table=table,
            policy=policy
        )

        # Should pick claude-3 (routed but not excluded)
        assert result == "claude-3"

    def test_route_preference_unavailable(self):
        """Test when preferred worker not available."""
        task = Task.create("task")
        policy = DispatchPolicy(preferred_workers=["unavailable-3"])

        result = route_task(
            task,
            ["claude-3", "codex-3"],
            policy=policy
        )

        # Should fall back to first available
        assert result == "claude-3"
