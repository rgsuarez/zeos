"""
Tests for Blueprint Parser Module (P1-5).
"""

import pytest
import tempfile
from pathlib import Path

import yaml

from overseer.blueprint import (
    BlueprintParser,
    BlueprintTask,
    BlueprintMetadata,
    Blueprint
)


class TestBlueprintTask:
    """Test BlueprintTask dataclass."""

    def test_task_creation_minimal(self):
        """Test creating task with minimal fields."""
        task = BlueprintTask(task_id="T-1", name="Test Task")
        assert task.task_id == "T-1"
        assert task.name == "Test Task"
        assert task.description == ""
        assert task.tier == 0
        assert task.verification_commands == []
        assert task.dependencies == []
        assert task.acceptance_criteria == []

    def test_task_creation_full(self):
        """Test creating task with all fields."""
        task = BlueprintTask(
            task_id="T-2",
            name="Full Task",
            description="A complete task",
            tier=1,
            verification_commands=["pytest tests/"],
            dependencies=["T-1"],
            acceptance_criteria=["All tests pass"]
        )
        assert task.tier == 1
        assert task.verification_commands == ["pytest tests/"]
        assert task.dependencies == ["T-1"]


class TestBlueprintMetadata:
    """Test BlueprintMetadata dataclass."""

    def test_metadata_defaults(self):
        """Test metadata default values."""
        meta = BlueprintMetadata()
        assert meta.name == ""
        assert meta.version == "1.0"
        assert meta.description == ""
        assert meta.author == ""
        assert meta.created_at == ""

    def test_metadata_custom(self):
        """Test metadata with custom values."""
        meta = BlueprintMetadata(
            name="Test Blueprint",
            version="2.0",
            description="Test description",
            author="Test Author",
            created_at="2026-01-28"
        )
        assert meta.name == "Test Blueprint"
        assert meta.version == "2.0"


class TestBlueprint:
    """Test Blueprint dataclass."""

    def test_blueprint_get_tier(self):
        """Test getting tasks by tier."""
        task1 = BlueprintTask(task_id="T-1", name="Task 1", tier=0)
        task2 = BlueprintTask(task_id="T-2", name="Task 2", tier=1)
        task3 = BlueprintTask(task_id="T-3", name="Task 3", tier=1)

        bp = Blueprint(
            metadata=BlueprintMetadata(name="Test"),
            tasks=[task1, task2, task3],
            tiers={0: [task1], 1: [task2, task3]}
        )

        assert len(bp.get_tier(0)) == 1
        assert len(bp.get_tier(1)) == 2
        assert bp.get_tier(2) == []

    def test_blueprint_get_task(self):
        """Test getting task by ID."""
        task1 = BlueprintTask(task_id="T-1", name="Task 1")
        task2 = BlueprintTask(task_id="T-2", name="Task 2")

        bp = Blueprint(
            metadata=BlueprintMetadata(),
            tasks=[task1, task2],
            tiers={}
        )

        found = bp.get_task("T-1")
        assert found is not None
        assert found.name == "Task 1"

        not_found = bp.get_task("T-99")
        assert not_found is None


class TestBlueprintParser:
    """Test BlueprintParser class."""

    def test_parser_creation(self):
        """Test parser instantiation."""
        parser = BlueprintParser()
        assert parser is not None

    def test_parse_dict_minimal(self):
        """Test parsing minimal dictionary."""
        parser = BlueprintParser()
        data = {
            "metadata": {"name": "Test"},
            "tiers": []
        }
        bp = parser.parse_dict(data)
        assert bp.metadata.name == "Test"
        assert bp.tasks == []

    def test_parse_dict_with_tasks(self):
        """Test parsing dictionary with tasks."""
        parser = BlueprintParser()
        data = {
            "metadata": {
                "name": "Test Blueprint",
                "version": "1.0"
            },
            "tiers": [
                {
                    "tier": 0,
                    "tasks": [
                        {
                            "id": "P0-1",
                            "name": "First Task",
                            "description": "Do something",
                            "verification": {
                                "test": "pytest tests/"
                            }
                        }
                    ]
                },
                {
                    "tier": 1,
                    "tasks": [
                        {
                            "id": "P1-1",
                            "name": "Second Task",
                            "dependencies": ["P0-1"]
                        }
                    ]
                }
            ]
        }

        bp = parser.parse_dict(data)
        assert len(bp.tasks) == 2
        assert len(bp.get_tier(0)) == 1
        assert len(bp.get_tier(1)) == 1
        assert bp.tasks[0].verification_commands == ["pytest tests/"]
        assert bp.tasks[1].dependencies == ["P0-1"]

    def test_parse_dict_verification_list(self):
        """Test parsing verification as list."""
        parser = BlueprintParser()
        data = {
            "tiers": [{
                "tier": 0,
                "tasks": [{
                    "id": "T-1",
                    "name": "Test",
                    "verification": ["cmd1", "cmd2"]
                }]
            }]
        }
        bp = parser.parse_dict(data)
        assert bp.tasks[0].verification_commands == ["cmd1", "cmd2"]

    def test_parse_file(self):
        """Test parsing from YAML file."""
        parser = BlueprintParser()

        yaml_content = """
metadata:
  name: File Test
  version: "2.0"
tiers:
  - tier: 0
    tasks:
      - id: FT-1
        name: File Task
        description: Test from file
"""

        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write(yaml_content)
            f.flush()
            temp_path = Path(f.name)

        try:
            bp = parser.parse_file(temp_path)
            assert bp.metadata.name == "File Test"
            assert bp.metadata.version == "2.0"
            assert len(bp.tasks) == 1
            assert bp.tasks[0].task_id == "FT-1"
        finally:
            temp_path.unlink()

    def test_parse_file_not_found(self):
        """Test parsing nonexistent file raises error."""
        parser = BlueprintParser()
        with pytest.raises(FileNotFoundError):
            parser.parse_file(Path("/nonexistent/file.yaml"))

    def test_extract_tasks(self):
        """Test extracting tasks in order."""
        parser = BlueprintParser()
        data = {
            "tiers": [
                {"tier": 2, "tasks": [{"id": "T-2", "name": "Tier 2"}]},
                {"tier": 0, "tasks": [{"id": "T-0", "name": "Tier 0"}]},
                {"tier": 1, "tasks": [{"id": "T-1", "name": "Tier 1"}]}
            ]
        }
        bp = parser.parse_dict(data)
        ordered = parser.extract_tasks(bp)

        # Should be ordered by tier number
        assert ordered[0].task_id == "T-0"
        assert ordered[1].task_id == "T-1"
        assert ordered[2].task_id == "T-2"


class TestLoadBlueprintTool:
    """Test load_blueprint MCP tool."""

    def test_load_blueprint_exists(self):
        """Test load_blueprint function exists."""
        from overseer.server import load_blueprint
        assert callable(load_blueprint)

    def test_load_blueprint_valid_file(self):
        """Test loading valid blueprint file."""
        from overseer.server import load_blueprint

        yaml_content = """
metadata:
  name: MCP Test
tiers:
  - tier: 0
    tasks:
      - id: MCP-1
        name: MCP Task
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write(yaml_content)
            f.flush()
            temp_path = f.name

        try:
            result = load_blueprint(requesting_agent="gemini-3", blueprint_path=temp_path)
            assert result["status"] == "loaded"
            assert result["name"] == "MCP Test"
            assert result["task_count"] == 1
            assert result["tier_count"] == 1
        finally:
            Path(temp_path).unlink()

    def test_load_blueprint_not_found(self):
        """Test loading nonexistent file."""
        from overseer.server import load_blueprint
        result = load_blueprint(requesting_agent="gemini-3", blueprint_path="/nonexistent/blueprint.yaml")
        assert result["status"] == "error"
        assert "not found" in result["error"].lower()


# Blueprint verification wrapper tests
def test_parse():
    """Blueprint verification: P1-5.2 - YAML parsing works."""
    parser = BlueprintParser()
    data = {
        "metadata": {"name": "Verify Parse"},
        "tiers": [{
            "tier": 0,
            "tasks": [{
                "id": "V-1",
                "name": "Verify Task",
                "verification": {"cmd": "echo ok"}
            }]
        }]
    }
    bp = parser.parse_dict(data)
    assert bp.metadata.name == "Verify Parse"
    assert len(bp.tasks) == 1
    assert bp.tasks[0].verification_commands == ["echo ok"]


def test_extract():
    """Blueprint verification: P1-5.3 - Task extraction works."""
    parser = BlueprintParser()
    data = {
        "tiers": [
            {"tier": 1, "tasks": [{"id": "E-1", "name": "T1"}]},
            {"tier": 0, "tasks": [{"id": "E-0", "name": "T0"}]}
        ]
    }
    bp = parser.parse_dict(data)
    ordered = parser.extract_tasks(bp)
    assert ordered[0].task_id == "E-0"  # Tier 0 first
    assert ordered[1].task_id == "E-1"  # Tier 1 second


def test_load_tool():
    """Blueprint verification: P1-5.4 - load_blueprint MCP tool works."""
    from overseer.server import load_blueprint

    yaml_content = """
metadata:
  name: Load Tool Test
tiers:
  - tier: 0
    tasks:
      - id: LT-1
        name: Load Test Task
"""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
        f.write(yaml_content)
        f.flush()
        temp_path = f.name

    try:
        result = load_blueprint(requesting_agent="gemini-3", blueprint_path=temp_path)
        assert result["status"] == "loaded"
        assert result["task_count"] == 1
    finally:
        Path(temp_path).unlink()
