"""
Unit tests for configuration management (P1-5.4).

Tests:
- OverseerConfig dataclass
- YAML loading (from_yaml, save_yaml)
- Environment variable overrides (load_config)
"""

import pytest
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from overseer.config import (
    OverseerConfig,
    load_config,
    get_config,
    DEFAULT_CONFIG_PATH,
)


class TestOverseerConfig:
    """Test OverseerConfig dataclass."""

    def test_default_values(self):
        """Test default configuration values."""
        config = OverseerConfig()

        assert config.heartbeat_interval == 60
        assert config.stuck_threshold == 300
        assert config.crashed_threshold == 600
        assert config.cache_ttl == 30.0
        assert config.polling_interval == 30.0
        assert config.rate_limit_tokens == 10
        assert config.message_ttl_hours == 24

    def test_custom_values(self):
        """Test custom configuration values."""
        config = OverseerConfig(
            heartbeat_interval=120,
            stuck_threshold=600,
            cache_ttl=60.0
        )

        assert config.heartbeat_interval == 120
        assert config.stuck_threshold == 600
        assert config.cache_ttl == 60.0

    def test_to_dict(self):
        """Test serialization to dictionary."""
        config = OverseerConfig(heartbeat_interval=90)
        data = config.to_dict()

        assert data["heartbeat_interval"] == 90
        assert "cache_ttl" in data
        assert "clawdbot_gateway_url" in data

    def test_from_dict(self):
        """Test deserialization from dictionary."""
        data = {
            "heartbeat_interval": 45,
            "cache_ttl": 15.0,
            "invalid_field": "ignored"
        }
        config = OverseerConfig.from_dict(data)

        assert config.heartbeat_interval == 45
        assert config.cache_ttl == 15.0


class TestYAMLConfig:
    """Test YAML configuration loading."""

    def test_from_yaml_file(self):
        """Test loading config from YAML file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write("""
heartbeat_interval: 120
cache_ttl: 45.0
clawdbot_gateway_url: https://example.com/events
""")
            f.flush()
            path = Path(f.name)

        try:
            config = OverseerConfig.from_yaml(path)

            assert config.heartbeat_interval == 120
            assert config.cache_ttl == 45.0
            assert config.clawdbot_gateway_url == "https://example.com/events"
        finally:
            path.unlink()

    def test_from_yaml_missing_file(self):
        """Test that missing file returns defaults."""
        config = OverseerConfig.from_yaml(Path("/nonexistent/config.yaml"))

        # Should return defaults
        assert config.heartbeat_interval == 60
        assert config.cache_ttl == 30.0

    def test_from_yaml_empty_file(self):
        """Test loading empty YAML file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write("")
            f.flush()
            path = Path(f.name)

        try:
            config = OverseerConfig.from_yaml(path)
            # Should return defaults
            assert config.heartbeat_interval == 60
        finally:
            path.unlink()

    def test_save_yaml(self):
        """Test saving config to YAML file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test_config.yaml"

            config = OverseerConfig(
                heartbeat_interval=180,
                cache_ttl=60.0
            )
            config.save_yaml(path)

            # Reload and verify
            loaded = OverseerConfig.from_yaml(path)
            assert loaded.heartbeat_interval == 180
            assert loaded.cache_ttl == 60.0


class TestEnvOverrides:
    """Test environment variable overrides."""

    def test_env_override_string(self):
        """Test string env var override."""
        with patch.dict(os.environ, {"CLAWDBOT_GATEWAY_URL": "https://test.example.com"}):
            with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
                f.write("clawdbot_gateway_url: https://original.com\n")
                f.flush()
                path = Path(f.name)

            try:
                config = load_config(path)
                # Env var should override file value
                assert config.clawdbot_gateway_url == "https://test.example.com"
            finally:
                path.unlink()

    def test_env_override_int(self):
        """Test integer env var override."""
        with patch.dict(os.environ, {"OVERSEER_HEARTBEAT_INTERVAL": "180"}):
            with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
                f.write("heartbeat_interval: 60\n")
                f.flush()
                path = Path(f.name)

            try:
                config = load_config(path)
                assert config.heartbeat_interval == 180
            finally:
                path.unlink()

    def test_env_override_float(self):
        """Test float env var override."""
        with patch.dict(os.environ, {"OVERSEER_CACHE_TTL": "45.5"}):
            config = load_config(Path("/nonexistent"))
            assert config.cache_ttl == 45.5

    def test_env_invalid_conversion(self):
        """Test that invalid env values are ignored."""
        with patch.dict(os.environ, {"OVERSEER_HEARTBEAT_INTERVAL": "not_a_number"}):
            config = load_config(Path("/nonexistent"))
            # Should keep default on conversion error
            assert config.heartbeat_interval == 60

    def test_all_env_overrides(self):
        """Test all supported env var overrides."""
        env_overrides = {
            "OVERSEER_DB_PATH": "/custom/path/db.sqlite",
            "OVERSEER_HEARTBEAT_INTERVAL": "120",
            "OVERSEER_STUCK_THRESHOLD": "600",
            "OVERSEER_CRASHED_THRESHOLD": "1200",
            "OVERSEER_CACHE_TTL": "60.0",
            "OVERSEER_POLLING_INTERVAL": "15.0",
            "OVERSEER_RATE_LIMIT_TOKENS": "20",
            "OVERSEER_RATE_LIMIT_PER_SECOND": "2.0",
            "OVERSEER_MESSAGE_TTL_HOURS": "48",
            "OVERSEER_PRUNE_INTERVAL": "7200",
            "CLAWDBOT_GATEWAY_URL": "https://gateway.test",
            "CLAWDBOT_GATEWAY_TOKEN": "secret_token",
        }

        with patch.dict(os.environ, env_overrides):
            config = load_config(Path("/nonexistent"))

            assert config.db_path == "/custom/path/db.sqlite"
            assert config.heartbeat_interval == 120
            assert config.stuck_threshold == 600
            assert config.crashed_threshold == 1200
            assert config.cache_ttl == 60.0
            assert config.polling_interval == 15.0
            assert config.rate_limit_tokens == 20
            assert config.rate_limit_per_second == 2.0
            assert config.message_ttl_hours == 48
            assert config.prune_interval == 7200
            assert config.clawdbot_gateway_url == "https://gateway.test"
            assert config.clawdbot_gateway_token == "secret_token"


class TestConfigSingleton:
    """Test global config singleton."""

    def test_get_config_singleton(self):
        """Test that get_config returns same instance."""
        import overseer.config as config_module

        # Reset singleton
        config_module._config = None

        config1 = get_config()
        config2 = get_config()

        assert config1 is config2

    def test_get_config_loads_defaults(self):
        """Test that get_config loads valid defaults."""
        import overseer.config as config_module
        config_module._config = None

        config = get_config()

        assert config.heartbeat_interval > 0
        assert config.cache_ttl > 0
