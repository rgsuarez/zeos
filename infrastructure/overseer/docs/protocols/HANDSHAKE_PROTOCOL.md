# 3-Way Handshake Protocol

**Version:** 1.0.0
**Status:** DRAFT
**Created:** 2026-01-25

## Objective
Establish a reliable, verified communication channel between agents (Sender -> Receiver) for command execution, eliminating "blind sends" and race conditions.

## The 3-Way Handshake (TCP-style)

1.  **SYN (Synchronize):** Sender requests to send a command.
    *   *Payload:* Intent, priority, timeout requirements.
2.  **SYN-ACK (Synchronize-Acknowledge):** Receiver confirms readiness.
    *   *Payload:* Readiness status, current load, session ID.
3.  **ACK (Acknowledge/Go):** Sender confirms the channel is open and authorizes execution.
    *   *Payload:* The actual command/instruction.

## Pre-Flight Checks (Mandatory)

Before initiating the handshake, the Sender **MUST**:
1.  **State Check:** Call `detect_state(receiver)` and verify `state == IDLE`.
2.  **Rate Limit Check:** Ensure token budget allows for 3 messages.

## Message Types

*   `handshake_syn`
*   `handshake_syn_ack`
*   `handshake_ack`

## Timeout Handling

*   **Default Timeout:** 30 seconds per step.
*   **SYN Timeout:** Sender aborts, logs "Receiver Unreachable".
*   **SYN-ACK Timeout:** Sender aborts, logs "Receiver Busy/Silent".
*   **ACK Timeout:** Receiver aborts (does not execute), logs "Sender Abandoned".

## State Transitions

| Step | Sender State | Receiver State | Action |
| :--- | :--- | :--- | :--- |
| **Start** | IDLE | IDLE | Sender Checks State |
| **1. SYN** | WAIT_SYN_ACK | IDLE -> HANDSHAKE | Sender sends SYN |
| **2. SYN-ACK** | WAIT_ACK | HANDSHAKE | Receiver sends SYN-ACK |
| **3. ACK** | EXECUTING | HANDSHAKE -> EXECUTING | Sender sends Command |
| **4. EXEC** | MONITORING | EXECUTING | Receiver runs command |