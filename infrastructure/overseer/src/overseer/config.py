"""
Overseer Configuration Management (P1-5).

Centralized configuration with YAML loading and env var override support.
"""

import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

# Default config path
DEFAULT_CONFIG_PATH = Path.home() / ".overseer" / "config.yaml"


@dataclass
class OverseerConfig:
    """
    Central configuration for Overseer MCP server (P1-5.1).

    Attributes:
        db_path: Path to SQLite relay database
        heartbeat_interval: Seconds between worker heartbeats
        stuck_threshold: Seconds of static output before STUCK status
        crashed_threshold: Seconds without heartbeat before CRASHED status
        cache_ttl: Seconds for tool result cache
        polling_interval: Seconds between subscribe polls
        rate_limit_tokens: Max burst tokens for rate limiter
        rate_limit_per_second: Token refill rate
        message_ttl_hours: Hours before messages expire
        prune_interval: Seconds between prune operations
        clawdbot_gateway_url: URL for Clawdbot push gateway
        clawdbot_gateway_token: Auth token for push gateway
        default_team_aliases: Default agent aliases to seed
    """
    # Database
    db_path: str = str(Path.home() / ".overseer" / "relay.db")

    # Coordination Multiplier Protocol
    heartbeat_interval: int = 60
    stuck_threshold: int = 300
    crashed_threshold: int = 600

    # Caching
    cache_ttl: float = 30.0

    # Polling
    polling_interval: float = 30.0

    # Rate Limiting
    rate_limit_tokens: int = 10
    rate_limit_per_second: float = 1.0

    # Message Retention
    message_ttl_hours: int = 24
    prune_interval: int = 3600

    # Push Notifications
    clawdbot_gateway_url: str = ""
    clawdbot_gateway_token: str = ""

    # Aliases
    default_team_aliases: Dict[str, List[Dict[str, str]]] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to dictionary."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "OverseerConfig":
        """Deserialize from dictionary."""
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    @classmethod
    def from_yaml(cls, path: Path) -> "OverseerConfig":
        """
        Load configuration from YAML file (P1-5.2).

        Args:
            path: Path to YAML config file

        Returns:
            OverseerConfig instance
        """
        if not path.exists():
            return cls()  # Return defaults if file doesn't exist

        with open(path, 'r') as f:
            data = yaml.safe_load(f) or {}

        return cls.from_dict(data)

    def save_yaml(self, path: Path):
        """Save configuration to YAML file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w') as f:
            yaml.safe_dump(self.to_dict(), f, default_flow_style=False)


def load_config(config_path: Optional[Path] = None) -> OverseerConfig:
    """
    Load configuration with environment variable overrides (P1-5.3).

    Priority (highest to lowest):
    1. Environment variables (OVERSEER_*)
    2. Config file values
    3. Default values

    Args:
        config_path: Optional path to config file (defaults to ~/.overseer/config.yaml)

    Returns:
        OverseerConfig with merged values
    """
    # Load from file
    path = config_path or DEFAULT_CONFIG_PATH
    config = OverseerConfig.from_yaml(path)

    # Apply environment variable overrides
    env_mappings = {
        "OVERSEER_DB_PATH": "db_path",
        "OVERSEER_HEARTBEAT_INTERVAL": ("heartbeat_interval", int),
        "OVERSEER_STUCK_THRESHOLD": ("stuck_threshold", int),
        "OVERSEER_CRASHED_THRESHOLD": ("crashed_threshold", int),
        "OVERSEER_CACHE_TTL": ("cache_ttl", float),
        "OVERSEER_POLLING_INTERVAL": ("polling_interval", float),
        "OVERSEER_RATE_LIMIT_TOKENS": ("rate_limit_tokens", int),
        "OVERSEER_RATE_LIMIT_PER_SECOND": ("rate_limit_per_second", float),
        "OVERSEER_MESSAGE_TTL_HOURS": ("message_ttl_hours", int),
        "OVERSEER_PRUNE_INTERVAL": ("prune_interval", int),
        "CLAWDBOT_GATEWAY_URL": "clawdbot_gateway_url",
        "CLAWDBOT_GATEWAY_TOKEN": "clawdbot_gateway_token",
    }

    for env_key, mapping in env_mappings.items():
        env_val = os.getenv(env_key)
        if env_val is not None:
            if isinstance(mapping, tuple):
                attr_name, converter = mapping
                try:
                    setattr(config, attr_name, converter(env_val))
                except (ValueError, TypeError):
                    pass  # Keep default on conversion error
            else:
                setattr(config, mapping, env_val)

    return config


def get_config() -> OverseerConfig:
    """
    Get the global configuration instance.

    Returns a singleton config loaded once.
    """
    global _config
    if _config is None:
        _config = load_config()
    return _config


# Global config singleton
_config: Optional[OverseerConfig] = None
