"""
Overseer Teams Module

Defines team structures, roles, and SOPs for multi-agent coordination.
Supports loading from zeos YAML configs with hardcoded fallback.
"""

from .definitions import TeamType, Role, TeamConfig, TEAM_CONFIGS, ActivationMode
from .definitions import get_team_config, list_available_configs, infer_role
from .sops import get_sop, ROLE_SOPS

__all__ = [
    "TeamType",
    "Role",
    "TeamConfig",
    "TEAM_CONFIGS",
    "ActivationMode",
    "get_team_config",
    "list_available_configs",
    "infer_role",
    "get_sop",
    "ROLE_SOPS",
]
