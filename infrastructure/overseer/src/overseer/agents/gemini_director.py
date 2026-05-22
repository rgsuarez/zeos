"""
Gemini Director Implementation

Concrete implementation of the Hive Director for Gemini.
"""

import json
from typing import List, Dict, Optional

from overseer.hive import Director, Task, TaskAcceptance, TaskCompletion, TaskBlocker, TaskStatus, TaskPriority

class GeminiDirector(Director):
    """
    Gemini-powered Director that orchestrates workers.
    """

    def __init__(self, name: str = "gemini"):
        super().__init__(name)
        # Round-robin index
        self._worker_index = 0

    def decompose(self, task: Task) -> List[Task]:
        """
        Decompose a high-level task into subtasks.
        
        For MVP, just creates one subtask that copies the original.
        In production, this would use LLM reasoning to break down the problem.
        """
        # MVP: 1-to-1 mapping
        subtask = Task.create(
            description=f"Execute: {task.description}",
            priority=task.priority,
            parent_task_id=task.task_id,
            context=task.context,
            acceptance_criteria=task.acceptance_criteria,
            deadline_seconds=task.deadline_seconds
        )
        self.tasks[subtask.task_id] = subtask
        return [subtask]

    def assign_task(self, task: Task, worker: str = None) -> str:
        """
        Assign a task to a specific worker.
        
        If worker is None, uses round-robin assignment.
        Returns the TASK_ASSIGN message payload.
        """
        if not self.workers:
            raise ValueError("No workers registered")

        if worker is None:
            worker = self.workers[self._worker_index]
            self._worker_index = (self._worker_index + 1) % len(self.workers)

        task.assigned_to = worker
        task.status = TaskStatus.ASSIGNED
        self.tasks[task.task_id] = task
        
        return task.to_assign_payload()

    def handle_acceptance(self, acceptance: TaskAcceptance):
        """Handle worker's task acceptance."""
        task = self.tasks.get(acceptance.task_id)
        if task:
            task.status = TaskStatus.ACCEPTED
            # print(f"Director {self.name}: Task {task.task_id} accepted by {acceptance.worker} (ETA: {acceptance.estimated_seconds}s)")

    def handle_completion(self, completion: TaskCompletion):
        """Handle worker's task completion report."""
        task = self.tasks.get(completion.task_id)
        if task:
            task.status = TaskStatus.COMPLETED
            # print(f"Director {self.name}: Task {task.task_id} completed by {completion.worker} (Status: {completion.status})")
            # print(f"Result: {completion.result}")

    def handle_blocker(self, blocker: TaskBlocker):
        """Handle worker's blocked report."""
        task = self.tasks.get(blocker.task_id)
        if task:
            task.status = TaskStatus.BLOCKED
            # print(f"Director {self.name}: Task {task.task_id} blocked by {blocker.worker} (Reason: {blocker.blocker})")
