# Handshake Protocol Test Plan

**Protocol:** 3-Way Handshake Protocol
**Version:** 1.0.0
**Status:** DRAFT
**Created:** 2026-01-25

## Objective
Validate the 3-way handshake reliability guarantees and failure handling for inter-agent command execution.

## Scope
- Handshake message sequencing (`handshake_syn`, `handshake_syn_ack`, `handshake_ack`)
- Pre-flight checks (state + rate limit)
- Timeout handling per step
- State transitions and abort behavior
- Isolation (team scoping)
- Observability (logs + relay messages)

## Out of Scope
- Low-level tmux transport reliability
- Non-handshake tools behavior not tied to this protocol
- Performance benchmarking beyond basic latency thresholds

## Preconditions
- Two active tmux sessions (Sender, Receiver) with Overseer MCP configured
- Relay DB initialized with strict team_id constraints
- Known team ID for both agents (e.g., `codex-3`, `gemini-3`)
- Time synchronized (UTC) for timeout validation

## Test Data
- Command payloads:
  - `echo HANDSHAKE_OK`
  - `sleep 5 && echo HANDSHAKE_SLOW`
  - `exit 1`
- Priorities: `low`, `medium`, `high`
- Timeouts: default 30s, custom 5s

## Acceptance Criteria
- No command executes without full 3-step handshake success
- Timeouts abort without side effects (no execution on Receiver)
- State transitions match protocol table
- Cross-team requests are denied by default
- Errors are explicit and actionable

## Test Matrix

### A. Happy Path
1. **A1: Basic handshake success**
   - Preconditions: Sender/Receiver IDLE
   - Steps: SYN -> SYN-ACK -> ACK (command)
   - Expected: Receiver executes command; relay logs all 3 message types

2. **A2: Custom timeout success**
   - Preconditions: IDLE
   - Steps: Use 5s timeout; complete handshake in <5s
   - Expected: Success; duration logged under timeout

### B. Pre-Flight Enforcement
3. **B1: Sender skips detect_state**
   - Steps: Attempt SYN without pre-flight
   - Expected: Sender aborts; error logged `PreflightRequired`

4. **B2: Receiver not IDLE**
   - Preconditions: Receiver WORKING
   - Steps: Sender runs pre-flight
   - Expected: Sender aborts; no SYN sent

5. **B3: Rate limit exceeded**
   - Preconditions: Exhaust token budget
   - Steps: Attempt handshake
   - Expected: Sender aborts; no messages sent

### C. Timeout Handling
6. **C1: SYN timeout**
   - Preconditions: Receiver offline
   - Steps: Send SYN
   - Expected: Sender aborts with `ReceiverUnreachable`

7. **C2: SYN-ACK timeout**
   - Preconditions: Receiver online but silent
   - Steps: Send SYN, no SYN-ACK
   - Expected: Sender aborts with `ReceiverBusyOrSilent`

8. **C3: ACK timeout**
   - Preconditions: Receiver sends SYN-ACK, Sender silent
   - Steps: Wait for ACK timeout
   - Expected: Receiver aborts without execution

### D. Ordering and Idempotency
9. **D1: Out-of-order messages**
   - Steps: Send ACK before SYN
   - Expected: Receiver rejects; logs `HandshakeOrderViolation`

10. **D2: Duplicate SYN**
    - Steps: Send same SYN twice
    - Expected: Receiver returns same SYN-ACK or rejects duplicate; no double execution

11. **D3: Duplicate ACK**
    - Steps: Resend ACK
    - Expected: No duplicate execution; idempotent handling

### E. Concurrency
12. **E1: Parallel handshakes to same Receiver**
    - Steps: Two Senders initiate handshake simultaneously
    - Expected: Receiver handles sequentially or rejects overlap; no race execution

13. **E2: Sender initiates multiple handshakes**
    - Steps: Sender starts two handshakes without completion
    - Expected: Second is rejected or queued; no mixed state

### F. Isolation and Security
14. **F1: Cross-team SYN**
    - Preconditions: Sender team != Receiver team
    - Steps: Send SYN
    - Expected: Denied; no ACK allowed; audit log

15. **F2: Legacy agent without team_id**
    - Steps: Attempt handshake
    - Expected: Denied with explicit error

### G. Observability
16. **G1: Relay log completeness**
    - Steps: Successful handshake
    - Expected: All 3 message types persisted with timestamps + team_id

17. **G2: Abort logging**
    - Steps: Trigger each timeout class
    - Expected: Structured log entry with reason and step

## Validation Steps (Manual)
- Use `detect_state`, `send_to_agent`, `get_messages` tools
- Verify state transitions by `detect_state` + relay log inspection
- Capture command output via `get_agent_output`

## Automation Notes
- Add pytest cases for handshake state machine once implementation lands
- Mock tmux interactions; avoid live dependencies
- Include coverage for each failure mode above

## Exit Criteria
- All A–G test cases pass
- No cross-team leakage
- Logs show deterministic abort reasons
- Documentation updated if behavior deviates from spec
