"""
Team Definitions

Defines team types, roles, and configurations for Overseer multi-agent coordination.
Supports loading from zeos team YAML configs with hardcoded fallback.
"""

import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional

import yaml

logger = logging.getLogger(__name__)

# Default zeos team configs path
ZEOS_TEAMS_PATH = Path.home() / "projects" / "zeos" / "profiles" / "operator" / "teams"


class TeamType(str, Enum):
    """Types of team configurations."""
    DIRECTOR_EXECUTOR_VALIDATOR = "dev"  # DEV team: Director + Executor + Validator
    VISUAL_DEV = "visual_dev"             # Visual DEV: Interactive terminals, no background workers
    SWARM = "swarm"                       # Flat hierarchy, all peers
    HIERARCHICAL = "hierarchical"         # Multi-level management


# Map YAML type strings to TeamType enum
_TYPE_MAP = {
    "director_executor_validator": TeamType.DIRECTOR_EXECUTOR_VALIDATOR,
    "dev": TeamType.DIRECTOR_EXECUTOR_VALIDATOR,
    "visual_dev": TeamType.VISUAL_DEV,
    "swarm": TeamType.SWARM,
    "hierarchical": TeamType.HIERARCHICAL,
}


class ActivationMode(str, Enum):
    """How team members are activated."""
    BACKGROUND = "background"   # Bootstrap workers in background (deprecated)
    VISUAL = "visual"           # Interactive terminals with visual handshake


class Role(str, Enum):
    """Roles within a team."""
    DIRECTOR = "director"      # Decomposes tasks, assigns, monitors
    EXECUTOR = "executor"      # Executes tasks, reports completion
    VALIDATOR = "validator"    # Verifies execution, issues GO/NOGO
    PEER = "peer"              # Equal participant (for swarm teams)


@dataclass
class TeamConfig:
    """Configuration for a team instance."""
    team_type: TeamType
    team_id: str
    roles: Dict[str, Role]  # agent_name -> role mapping
    description: Optional[str] = None
    activation_mode: ActivationMode = ActivationMode.VISUAL  # Default to visual
    require_handshake: bool = True   # Require visual handshake before tasking
    require_ack: bool = True         # Require explicit ACK for each task
    source: Optional[str] = None     # "yaml" or "hardcoded" — where config came from

    def get_role(self, agent_name: str) -> Optional[Role]:
        """Get role for an agent, with fallback to base name matching."""
        # Direct match
        if agent_name in self.roles:
            return self.roles[agent_name]

        # Match by base name (e.g., "claude-3" matches "claude")
        base_name = agent_name.split('-')[0] if '-' in agent_name else agent_name
        for name, role in self.roles.items():
            if name == base_name or name.split('-')[0] == base_name:
                return role

        return None

    def get_agents_by_role(self, role: Role) -> List[str]:
        """Get all agents with a specific role."""
        return [name for name, r in self.roles.items() if r == role]


def _load_yaml_config(yaml_path: Path) -> Optional[TeamConfig]:
    """Load a TeamConfig from a zeos team YAML file."""
    try:
        with open(yaml_path) as f:
            data = yaml.safe_load(f)

        if not data or not isinstance(data, dict):
            return None

        # Parse team type
        raw_type = data.get("type", "director_executor_validator")
        team_type = _TYPE_MAP.get(raw_type)
        if team_type is None:
            logger.warning("Unknown team type '%s' in %s", raw_type, yaml_path)
            return None

        # Parse agents into roles dict
        agents_data = data.get("agents", {})
        roles: Dict[str, Role] = {}
        for agent_name, agent_info in agents_data.items():
            role_str = agent_info.get("role", "executor")
            try:
                roles[agent_name] = Role(role_str)
            except ValueError:
                logger.warning("Unknown role '%s' for agent '%s' in %s", role_str, agent_name, yaml_path)
                roles[agent_name] = Role.EXECUTOR

        # Parse activation settings
        activation = data.get("activation", {})
        mode_str = activation.get("mode", "visual")
        try:
            activation_mode = ActivationMode(mode_str)
        except ValueError:
            activation_mode = ActivationMode.VISUAL

        return TeamConfig(
            team_type=team_type,
            team_id=data.get("team_id", yaml_path.stem),
            roles=roles,
            description=data.get("name", yaml_path.stem),
            activation_mode=activation_mode,
            require_handshake=activation.get("require_handshake", True),
            require_ack=True,
            source="yaml",
        )
    except Exception as e:
        logger.warning("Failed to load YAML config %s: %s", yaml_path, e)
        return None


# Hardcoded fallback configurations (backward compatibility)
_HARDCODED_CONFIGS: Dict[str, TeamConfig] = {
    "dev": TeamConfig(
        team_type=TeamType.DIRECTOR_EXECUTOR_VALIDATOR,
        team_id="dev",
        roles={
            "gemini": Role.DIRECTOR,
            "claude": Role.EXECUTOR,
            "codex": Role.VALIDATOR,
        },
        description="Development team: Gemini directs, Claude executes, Codex validates",
        activation_mode=ActivationMode.BACKGROUND,  # Legacy mode
        require_handshake=False,
        require_ack=True,
        source="hardcoded",
    ),
    "dev-3": TeamConfig(
        team_type=TeamType.DIRECTOR_EXECUTOR_VALIDATOR,
        team_id="3",
        roles={
            "gemini-3": Role.DIRECTOR,
            "claude-3": Role.EXECUTOR,
            "codex-3": Role.VALIDATOR,
        },
        description="Team 3: Director-Executor-Validator configuration",
        activation_mode=ActivationMode.BACKGROUND,  # Legacy mode
        require_handshake=False,
        require_ack=True,
        source="hardcoded",
    ),
    "visual-dev-3": TeamConfig(
        team_type=TeamType.VISUAL_DEV,
        team_id="3",
        roles={
            "gemini-3": Role.DIRECTOR,
            "claude-3": Role.EXECUTOR,
            "codex-3": Role.VALIDATOR,
        },
        description="Visual DEV Team 3: Interactive terminals, visual handshake required",
        activation_mode=ActivationMode.VISUAL,
        require_handshake=True,   # Director must receive role ACK before tasking
        require_ack=True,          # Each task requires explicit acknowledgement
        source="hardcoded",
    ),
}


# Backward-compatible alias — existing code imports TEAM_CONFIGS
TEAM_CONFIGS = _HARDCODED_CONFIGS


def get_team_config(team_id: str, yaml_dir: Optional[Path] = None) -> Optional[TeamConfig]:
    """
    Get team configuration by ID.

    Resolution order:
    1. YAML file at {yaml_dir}/{team_id}.yaml (if yaml_dir provided or ZEOS_TEAMS_PATH exists)
    2. Hardcoded fallback configs

    Args:
        team_id: Team config identifier (e.g., "team-2", "cm-review", "dev")
        yaml_dir: Directory containing YAML team configs. Defaults to ZEOS_TEAMS_PATH.
    """
    # Try YAML first
    search_dir = yaml_dir or ZEOS_TEAMS_PATH
    if search_dir.is_dir():
        yaml_path = search_dir / f"{team_id}.yaml"
        if yaml_path.is_file():
            config = _load_yaml_config(yaml_path)
            if config:
                logger.info("Loaded team config '%s' from YAML: %s", team_id, yaml_path)
                return config

    # Fall back to hardcoded
    config = _HARDCODED_CONFIGS.get(team_id)
    if config:
        logger.info("Loaded team config '%s' from hardcoded fallback", team_id)
    return config


def list_available_configs(yaml_dir: Optional[Path] = None) -> List[str]:
    """List available team config names from YAML files and hardcoded configs."""
    configs = set(_HARDCODED_CONFIGS.keys())

    search_dir = yaml_dir or ZEOS_TEAMS_PATH
    if search_dir.is_dir():
        for yaml_file in search_dir.glob("*.yaml"):
            configs.add(yaml_file.stem)

    return sorted(configs)


def infer_role(agent_name: str, team_id: Optional[str] = None) -> Optional[Role]:
    """
    Infer role from agent name using default mappings.

    Default mapping (when team_id not specified or not found):
    - gemini* -> DIRECTOR
    - claude* -> EXECUTOR
    - codex* -> VALIDATOR
    """
    # Try team config first
    if team_id:
        config = get_team_config(team_id)
        if config:
            role = config.get_role(agent_name)
            if role:
                return role

    # Default inference by agent base name
    base = agent_name.split('-')[0].lower() if '-' in agent_name else agent_name.lower()

    defaults = {
        "gemini": Role.DIRECTOR,
        "claude": Role.EXECUTOR,
        "codex": Role.VALIDATOR,
    }

    return defaults.get(base)
