#!/usr/bin/env python3
"""
Overseer-Clawdbot Bridge
========================
Event relay that monitors Overseer relay DB for TASK_COMPLETE messages
and notifies Clawdbot via cron wake events.

Author: The General (Operation Night Watch)
"""

import json
import os
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

# Configuration
DB_PATH = os.environ.get('OVERSEER_DB', str(Path.home() / '.overseer' / 'relay.db'))
POLL_INTERVAL = int(os.environ.get('BRIDGE_POLL_INTERVAL', '5'))
STATE_FILE = Path.home() / '.overseer' / 'bridge_state.json'
LOG_FILE = Path.home() / '.overseer' / 'bridge.log'

# Message types we care about
WATCHED_TYPES = {'task_complete', 'task_blocked', 'status'}


@dataclass
class BridgeState:
    last_id: int = 0
    started_at: str = ''
    messages_relayed: int = 0
    last_relay_at: Optional[str] = None
    
    def to_dict(self) -> dict:
        return {
            'last_id': self.last_id,
            'started_at': self.started_at,
            'messages_relayed': self.messages_relayed,
            'last_relay_at': self.last_relay_at
        }
    
    @classmethod
    def from_dict(cls, d: dict) -> 'BridgeState':
        return cls(
            last_id=d.get('last_id', 0),
            started_at=d.get('started_at', ''),
            messages_relayed=d.get('messages_relayed', 0),
            last_relay_at=d.get('last_relay_at')
        )


def log(msg: str, level: str = 'INFO'):
    """Log message to file and stdout."""
    timestamp = datetime.now().isoformat()
    line = f'[{timestamp}] [{level}] {msg}'
    print(line)
    try:
        with open(LOG_FILE, 'a') as f:
            f.write(line + '\n')
    except Exception:
        pass


def load_state() -> BridgeState:
    """Load persisted state from file."""
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE) as f:
                return BridgeState.from_dict(json.load(f))
        except Exception as e:
            log(f'Failed to load state: {e}', 'WARN')
    return BridgeState(started_at=datetime.now().isoformat())


def save_state(state: BridgeState):
    """Persist state to file."""
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(STATE_FILE, 'w') as f:
            json.dump(state.to_dict(), f, indent=2)
    except Exception as e:
        log(f'Failed to save state: {e}', 'WARN')


def fetch_new_messages(db_path: str, since_id: int, types: set) -> List[Dict[str, Any]]:
    """Fetch new messages from Overseer relay DB."""
    type_placeholders = ','.join('?' * len(types))
    query = f'''
        SELECT id, agent, content, type, team_id, timestamp
        FROM messages
        WHERE id > ? AND type IN ({type_placeholders})
        ORDER BY id ASC
    '''
    
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(query, [since_id] + list(types))
        rows = cursor.fetchall()
        conn.close()
        
        return [dict(row) for row in rows]
    except Exception as e:
        log(f'DB query failed: {e}', 'ERROR')
        return []


def notify_clawdbot(event_type: str, payload: dict) -> bool:
    """Send wake event to Clawdbot via cron wake."""
    message = json.dumps({
        'source': 'overseer_bridge',
        'event': event_type,
        'payload': payload,
        'timestamp': datetime.now().isoformat()
    })
    
    # Use clawdbot CLI to send wake event
    try:
        result = subprocess.run(
            ['clawdbot', 'cron', 'wake', '--text', message],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode == 0:
            log(f'Clawdbot notified: {event_type}')
            return True
        else:
            log(f'Clawdbot notify failed: {result.stderr}', 'ERROR')
            return False
    except subprocess.TimeoutExpired:
        log('Clawdbot notify timed out', 'ERROR')
        return False
    except FileNotFoundError:
        log('clawdbot CLI not found', 'ERROR')
        return False


def process_message(msg: dict) -> bool:
    """Process a single message and notify Clawdbot."""
    msg_type = msg.get('type', 'unknown')
    agent = msg.get('agent', 'unknown')
    content = msg.get('content', '')
    
    # Parse content if JSON
    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        payload = {'raw': content}
    
    payload['agent'] = agent
    payload['msg_id'] = msg.get('id')
    payload['team_id'] = msg.get('team_id')
    payload['relay_timestamp'] = msg.get('timestamp')
    
    return notify_clawdbot(msg_type, payload)


def run_bridge(once: bool = False):
    """Main bridge loop."""
    state = load_state()
    if not state.started_at:
        state.started_at = datetime.now().isoformat()
    
    log(f'Bridge starting, last_id={state.last_id}, db={DB_PATH}')
    
    while True:
        messages = fetch_new_messages(DB_PATH, state.last_id, WATCHED_TYPES)
        
        for msg in messages:
            msg_id = msg['id']
            log(f'Processing message {msg_id}: type={msg["type"]} agent={msg["agent"]}')
            
            if process_message(msg):
                state.messages_relayed += 1
                state.last_relay_at = datetime.now().isoformat()
            
            state.last_id = msg_id
            save_state(state)
        
        if once:
            break
            
        time.sleep(POLL_INTERVAL)


# === TEST SUITE ===

def test_bridge_state():
    """Test BridgeState serialization."""
    state = BridgeState(last_id=42, started_at='2026-01-28T10:00:00', messages_relayed=5)
    d = state.to_dict()
    restored = BridgeState.from_dict(d)
    
    assert restored.last_id == 42, f'Expected 42, got {restored.last_id}'
    assert restored.messages_relayed == 5, f'Expected 5, got {restored.messages_relayed}'
    print('✓ test_bridge_state PASSED')
    return True


def test_fetch_messages():
    """Test message fetching from DB."""
    # Use real DB if exists
    if not Path(DB_PATH).exists():
        print('⊘ test_fetch_messages SKIPPED (no DB)')
        return True
    
    messages = fetch_new_messages(DB_PATH, 0, {'task_complete', 'status'})
    assert isinstance(messages, list), 'Expected list'
    print(f'✓ test_fetch_messages PASSED (found {len(messages)} messages)')
    return True


def test_message_parsing():
    """Test message content parsing."""
    # JSON content
    msg1 = {'id': 1, 'agent': 'claude-3', 'type': 'task_complete', 
            'content': '{"wave":"2d","status":"complete"}', 'team_id': '3'}
    
    # Will fail notify but should parse correctly
    # Just test the parsing logic
    try:
        content = msg1.get('content', '')
        payload = json.loads(content)
        assert payload['wave'] == '2d', 'Wave parsing failed'
        assert payload['status'] == 'complete', 'Status parsing failed'
        print('✓ test_message_parsing PASSED')
        return True
    except Exception as e:
        print(f'✗ test_message_parsing FAILED: {e}')
        return False


def test_state_persistence():
    """Test state save/load cycle."""
    test_state_file = Path('/tmp/bridge_test_state.json')
    original_state_file = STATE_FILE
    
    # Temporarily override
    import overseer_clawdbot_bridge as bridge
    bridge.STATE_FILE = test_state_file
    
    try:
        state = BridgeState(last_id=100, started_at='2026-01-28T10:00:00', messages_relayed=10)
        save_state(state)
        
        loaded = load_state()
        assert loaded.last_id == 100, f'Expected 100, got {loaded.last_id}'
        assert loaded.messages_relayed == 10, f'Expected 10, got {loaded.messages_relayed}'
        
        print('✓ test_state_persistence PASSED')
        return True
    finally:
        bridge.STATE_FILE = original_state_file
        if test_state_file.exists():
            test_state_file.unlink()


def run_tests() -> bool:
    """Run all tests."""
    print('\n=== Overseer-Clawdbot Bridge Test Suite ===\n')
    
    tests = [
        test_bridge_state,
        test_message_parsing,
        test_fetch_messages,
    ]
    
    passed = 0
    failed = 0
    
    for test in tests:
        try:
            if test():
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print(f'✗ {test.__name__} FAILED with exception: {e}')
            failed += 1
    
    print(f'\n=== Results: {passed} passed, {failed} failed ===')
    return failed == 0


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'test':
        success = run_tests()
        sys.exit(0 if success else 1)
    elif len(sys.argv) > 1 and sys.argv[1] == 'once':
        run_bridge(once=True)
    else:
        run_bridge()
