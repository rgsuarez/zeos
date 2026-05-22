"""
Overseer Team Protocol

Defines the Director/Worker topology for autonomous multi-agent orchestration.
- Director: Decomposes tasks, assigns to workers, tracks progress
- Worker: Receives tasks, executes, reports completion/blockers
"""

import json
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import List, Optional, Dict, Any


class TaskPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class TaskStatus(str, Enum):
    PENDING = "pending"
    ASSIGNED = "assigned"
    ACCEPTED = "accepted"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"
    FAILED = "failed"


class TaskResultStatus(str, Enum):
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"


@dataclass
class TaskContext:
    """Additional context for task execution."""
    files: List[str] = field(default_factory=list)
    codebase: Optional[str] = None
    notes: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Task:
    """Represents a unit of work in the Hive protocol."""
    task_id: str
    description: str
    assigned_to: Optional[str] = None
    priority: TaskPriority = TaskPriority.MEDIUM
    parent_task_id: Optional[str] = None
    context: Optional[TaskContext] = None
    acceptance_criteria: List[str] = field(default_factory=list)
    deadline_seconds: Optional[int] = None
    status: TaskStatus = TaskStatus.PENDING
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    # Coordination Multiplier Evolution
    expected_duration_sec: Optional[int] = None      # Estimated task duration
    heartbeat_interval_sec: int = 60                 # Heartbeat frequency (default 60s)

    @classmethod
    def create(
        cls,
        description: str,
        priority: TaskPriority = TaskPriority.MEDIUM,
        parent_task_id: Optional[str] = None,
        context: Optional[TaskContext] = None,
        acceptance_criteria: Optional[List[str]] = None,
        deadline_seconds: Optional[int] = None,
        expected_duration_sec: Optional[int] = None,
        heartbeat_interval_sec: int = 60
    ) -> "Task":
        """Factory method to create a new task with generated ID."""
        return cls(
            task_id=str(uuid.uuid4()),
            description=description,
            priority=priority,
            parent_task_id=parent_task_id,
            context=context,
            acceptance_criteria=acceptance_criteria or [],
            deadline_seconds=deadline_seconds,
            expected_duration_sec=expected_duration_sec,
            heartbeat_interval_sec=heartbeat_interval_sec
        )

    def to_assign_payload(self) -> str:
        """Serialize to JSON for TASK_ASSIGN message content."""
        data = {
            "task_id": self.task_id,
            "description": self.description,
            "assigned_to": self.assigned_to,
            "priority": self.priority.value,
            "parent_task_id": self.parent_task_id,
            "context": asdict(self.context) if self.context else None,
            "acceptance_criteria": self.acceptance_criteria,
            "deadline_seconds": self.deadline_seconds,
            # Coordination Multiplier Evolution
            "expected_duration_sec": self.expected_duration_sec,
            "heartbeat_interval_sec": self.heartbeat_interval_sec
        }
        return json.dumps(data)

    @classmethod
    def from_assign_payload(cls, payload: str) -> "Task":
        """Deserialize from TASK_ASSIGN message content."""
        data = json.loads(payload)
        context = None
        if data.get("context"):
            context = TaskContext(**data["context"])
        return cls(
            task_id=data["task_id"],
            description=data["description"],
            assigned_to=data.get("assigned_to"),
            priority=TaskPriority(data.get("priority", "medium")),
            parent_task_id=data.get("parent_task_id"),
            context=context,
            acceptance_criteria=data.get("acceptance_criteria", []),
            deadline_seconds=data.get("deadline_seconds"),
            status=TaskStatus.ASSIGNED,
            # Coordination Multiplier Evolution
            expected_duration_sec=data.get("expected_duration_sec"),
            heartbeat_interval_sec=data.get("heartbeat_interval_sec", 60)
        )


@dataclass
class TaskAcceptance:
    """Worker's acceptance of a task."""
    task_id: str
    worker: str
    estimated_seconds: Optional[int] = None

    def to_payload(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_payload(cls, payload: str) -> "TaskAcceptance":
        return cls(**json.loads(payload))


@dataclass
class TaskCompletion:
    """Worker's completion report for a task."""
    task_id: str
    worker: str
    status: TaskResultStatus
    result: str
    artifacts: List[str] = field(default_factory=list)
    notes: Optional[str] = None

    def to_payload(self) -> str:
        data = asdict(self)
        data["status"] = self.status.value
        return json.dumps(data)

    @classmethod
    def from_payload(cls, payload: str) -> "TaskCompletion":
        data = json.loads(payload)
        data["status"] = TaskResultStatus(data["status"])
        return cls(**data)


@dataclass
class TaskBlocker:
    """Worker's report that a task is blocked."""
    task_id: str
    worker: str
    blocker: str
    blocking_task_id: Optional[str] = None

    def to_payload(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_payload(cls, payload: str) -> "TaskBlocker":
        return cls(**json.loads(payload))


@dataclass
class Heartbeat:
    """
    Worker heartbeat for Coordination Multiplier Protocol.

    Workers post heartbeats every `heartbeat_interval_sec` during task execution
    to signal progress and prove activity.
    """
    worker: str
    task_id: str
    progress_pct: int = 0
    current_action: str = ""
    terminal_hash: str = ""
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_payload(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_payload(cls, payload: str) -> "Heartbeat":
        return cls(**json.loads(payload))


@dataclass
class ProgressCheckpoint:
    """
    Progress checkpoint for task tracking (P1-1.1).

    Records milestone progress during task execution.
    Used by Directors to track worker progress and estimate completion.
    """
    task_id: str
    worker: str
    milestone: str
    progress_pct: int
    eta_seconds: Optional[int] = None
    artifacts: List[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_payload(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_payload(cls, payload: str) -> "ProgressCheckpoint":
        return cls(**json.loads(payload))


@dataclass
class DispatchPolicy:
    """
    Policy for task dispatch decisions (P1-3.1).

    Defines routing rules and worker preferences for task assignment.
    """
    max_retries: int = 3
    timeout_seconds: int = 300
    preferred_workers: List[str] = field(default_factory=list)
    excluded_workers: List[str] = field(default_factory=list)
    require_ack: bool = True
    ack_timeout_seconds: int = 30
    priority_boost: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DispatchPolicy":
        return cls(**data)


@dataclass
class RoutingTable:
    """
    Worker routing table for Director use (P1-3.2).

    Maps task types/patterns to preferred workers.
    """
    routes: Dict[str, List[str]] = field(default_factory=dict)

    def add_route(self, pattern: str, workers: List[str]):
        """Add routing rule: task pattern -> worker list."""
        self.routes[pattern] = workers

    def get_workers(self, task_description: str) -> List[str]:
        """Get preferred workers for a task based on routing rules."""
        import re
        for pattern, workers in self.routes.items():
            if re.search(pattern, task_description, re.IGNORECASE):
                return workers
        return []

    def to_dict(self) -> Dict[str, Any]:
        return {"routes": self.routes}

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RoutingTable":
        return cls(routes=data.get("routes", {}))


def route_task(
    task: Task,
    available_workers: List[str],
    routing_table: Optional[RoutingTable] = None,
    policy: Optional[DispatchPolicy] = None
) -> Optional[str]:
    """
    Select best worker for a task (P1-3.3).

    Applies routing rules and policy constraints to select a worker.

    Args:
        task: Task to route
        available_workers: List of currently available workers
        routing_table: Optional routing rules
        policy: Optional dispatch policy with preferences/exclusions

    Returns:
        Selected worker name, or None if no suitable worker found
    """
    if not available_workers:
        return None

    candidates = list(available_workers)

    # Apply policy exclusions
    if policy and policy.excluded_workers:
        candidates = [w for w in candidates if w not in policy.excluded_workers]

    if not candidates:
        return None

    # Apply routing table
    if routing_table:
        routed = routing_table.get_workers(task.description)
        if routed:
            # Prefer routed workers that are available
            preferred = [w for w in routed if w in candidates]
            if preferred:
                candidates = preferred

    # Apply policy preferences
    if policy and policy.preferred_workers:
        preferred = [w for w in policy.preferred_workers if w in candidates]
        if preferred:
            candidates = preferred

    # Return first available candidate
    return candidates[0] if candidates else None


class Worker(ABC):
    """
    Abstract base class for Hive workers.

    Workers receive tasks from Directors, execute them, and report results.
    """

    def __init__(self, name: str):
        self.name = name
        self.current_task: Optional[Task] = None

    @abstractmethod
    def handle_assignment(self, task: Task) -> TaskAcceptance:
        """
        Handle incoming task assignment.

        Returns TaskAcceptance if worker can take the task.
        Raises exception or returns None if cannot accept.
        """
        pass

    @abstractmethod
    def execute(self, task: Task) -> TaskCompletion:
        """
        Execute the assigned task.

        Returns TaskCompletion with results.
        """
        pass

    def report_blocked(self, task: Task, blocker: str, blocking_task_id: Optional[str] = None) -> TaskBlocker:
        """Report that current task is blocked."""
        return TaskBlocker(
            task_id=task.task_id,
            worker=self.name,
            blocker=blocker,
            blocking_task_id=blocking_task_id
        )


class Agent(ABC):
    """
    Abstract base class for Hive directors.

    Directors decompose high-level tasks, assign to workers, and track progress.
    """

    def __init__(self, name: str):
        self.name = name
        self.tasks: Dict[str, Task] = {}
        self.workers: List[str] = []

    def register_worker(self, worker_name: str):
        """Register a worker as available for task assignment."""
        if worker_name not in self.workers:
            self.workers.append(worker_name)

    def unregister_worker(self, worker_name: str):
        """Remove a worker from the available pool."""
        if worker_name in self.workers:
            self.workers.remove(worker_name)

    @abstractmethod
    def decompose(self, task: Task) -> List[Task]:
        """
        Decompose a high-level task into subtasks.

        Returns list of subtasks with parent_task_id set.
        """
        pass

    @abstractmethod
    def assign_task(self, task: Task, worker: str) -> str:
        """
        Assign a task to a specific worker.

        Returns the TASK_ASSIGN message payload.
        """
        pass

    @abstractmethod
    def handle_acceptance(self, acceptance: TaskAcceptance):
        """Handle worker's task acceptance."""
        pass

    @abstractmethod
    def handle_completion(self, completion: TaskCompletion):
        """Handle worker's task completion report."""
        pass

    @abstractmethod
    def handle_blocker(self, blocker: TaskBlocker):
        """Handle worker's blocked report."""
        pass

    def get_task_status(self, task_id: str) -> Optional[TaskStatus]:
        """Get current status of a task."""
        task = self.tasks.get(task_id)
        return task.status if task else None
