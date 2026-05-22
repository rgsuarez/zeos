"""
Blueprint Parser Module for Overseer (P1-5).

Parses blueprint YAML files for task-aware execution.
"""

import yaml
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class BlueprintTask:
    """A single task from a blueprint."""
    task_id: str
    name: str
    description: str = ""
    tier: int = 0
    verification_commands: List[str] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)
    acceptance_criteria: List[str] = field(default_factory=list)


@dataclass
class BlueprintMetadata:
    """Blueprint metadata."""
    name: str = ""
    version: str = "1.0"
    description: str = ""
    author: str = ""
    created_at: str = ""


@dataclass
class Blueprint:
    """Parsed blueprint with metadata and tasks."""
    metadata: BlueprintMetadata
    tasks: List[BlueprintTask]
    tiers: Dict[int, List[BlueprintTask]] = field(default_factory=dict)

    def get_tier(self, tier_num: int) -> List[BlueprintTask]:
        """Get all tasks for a specific tier."""
        return self.tiers.get(tier_num, [])

    def get_task(self, task_id: str) -> Optional[BlueprintTask]:
        """Get a task by ID."""
        for task in self.tasks:
            if task.task_id == task_id:
                return task
        return None


class BlueprintParser:
    """
    Parser for blueprint YAML files.

    Usage:
        parser = BlueprintParser()
        blueprint = parser.parse_file(Path("blueprint.yaml"))
        tasks = blueprint.get_tier(1)
    """

    def __init__(self):
        pass

    def parse_file(self, path: Path) -> Blueprint:
        """
        Parse a blueprint from a YAML file.

        Args:
            path: Path to blueprint YAML file

        Returns:
            Parsed Blueprint object
        """
        if not path.exists():
            raise FileNotFoundError(f"Blueprint file not found: {path}")

        with open(path, 'r') as f:
            data = yaml.safe_load(f)

        return self.parse_dict(data)

    def parse_dict(self, data: Dict[str, Any]) -> Blueprint:
        """
        Parse a blueprint from a dictionary.

        Args:
            data: Blueprint data as dictionary

        Returns:
            Parsed Blueprint object
        """
        # Parse metadata
        meta_data = data.get("metadata", {})
        metadata = BlueprintMetadata(
            name=meta_data.get("name", ""),
            version=meta_data.get("version", "1.0"),
            description=meta_data.get("description", ""),
            author=meta_data.get("author", ""),
            created_at=meta_data.get("created_at", "")
        )

        # Parse tiers and tasks
        tasks: List[BlueprintTask] = []
        tiers: Dict[int, List[BlueprintTask]] = {}

        tiers_data = data.get("tiers", [])
        for tier_data in tiers_data:
            tier_num = tier_data.get("tier", 0)
            tier_tasks = []

            for task_data in tier_data.get("tasks", []):
                task = self._parse_task(task_data, tier_num)
                tasks.append(task)
                tier_tasks.append(task)

            tiers[tier_num] = tier_tasks

        return Blueprint(
            metadata=metadata,
            tasks=tasks,
            tiers=tiers
        )

    def _parse_task(self, data: Dict[str, Any], tier: int) -> BlueprintTask:
        """Parse a single task from dictionary."""
        verification = data.get("verification", {})
        commands = []

        # Extract verification commands
        if isinstance(verification, dict):
            for key, value in verification.items():
                if isinstance(value, str):
                    commands.append(value)
                elif isinstance(value, list):
                    commands.extend(value)
        elif isinstance(verification, list):
            commands = verification

        return BlueprintTask(
            task_id=data.get("id", ""),
            name=data.get("name", ""),
            description=data.get("description", ""),
            tier=tier,
            verification_commands=commands,
            dependencies=data.get("dependencies", []),
            acceptance_criteria=data.get("acceptance_criteria", [])
        )

    def extract_tasks(self, blueprint: Blueprint) -> List[BlueprintTask]:
        """
        Extract all tasks from a blueprint in dependency order.

        Args:
            blueprint: Parsed blueprint

        Returns:
            List of tasks ordered by tier then position
        """
        ordered_tasks = []
        for tier_num in sorted(blueprint.tiers.keys()):
            ordered_tasks.extend(blueprint.tiers[tier_num])
        return ordered_tasks
