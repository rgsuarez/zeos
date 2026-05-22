
import subprocess
import sys
import re
from overseer.detector import StateDetector

def get_tmux_output(agent):
    try:
        result = subprocess.run(
            ["tmux", "capture-pane", "-t", agent, "-p", "-S", "-50"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode != 0:
            return None
        return result.stdout
    except Exception:
        return None

def main():
    detector = StateDetector()
    
    # Check Claude
    claude_out = get_tmux_output("claude")
    if claude_out:
        state = detector.detect("claude", claude_out)
        print(f"Claude State: {state}")
        print("--- Claude Output Snippet ---")
        print(claude_out[-300:])
        print("-----------------------------")
    else:
        print("Claude State: UNREACHABLE")

    # Check Gemini (ourselves - might be tricky if we are looking at ourself looking at ourself)
    gemini_out = get_tmux_output("gemini")
    if gemini_out:
        state = detector.detect("gemini", gemini_out)
        print(f"Gemini State: {state}")
    else:
        print("Gemini State: UNREACHABLE")

if __name__ == "__main__":
    main()
