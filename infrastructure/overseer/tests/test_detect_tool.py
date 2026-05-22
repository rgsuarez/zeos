

import pytest
from overseer.server import detect_state, mcp, get_agent_output
from overseer.detector import AgentState

class TestDetectStateTool:
    def test_detect_state_integration(self, monkeypatch):
        """Test the tool logic mocking the capture output."""
        
        # Mock subprocess.run in server.py
        import subprocess
        
        class MockResult:
            returncode = 0
            stdout = "Thinking...\nProcessing..."
            stderr = ""
            
        def mock_run(*args, **kwargs):
            return MockResult()
            
        monkeypatch.setattr("subprocess.run", mock_run)
        
        result = detect_state("gemini")
        assert result["agent"] == "gemini"
        assert result["state"] == AgentState.WORKING
