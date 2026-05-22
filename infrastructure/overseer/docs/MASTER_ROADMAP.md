# Overseer Master Roadmap

> Multi-agent visibility — one pane of glass.

## Current Phase: Phase 3.1 Complete → Phase 4 Next

### Phase 1: tmux Capture MVP
**Goal:** Basic working prototype where Gemini can see Claude's output

**Deliverables:**
- [ ] FastMCP server skeleton
- [ ] `get_agent_output` tool (tmux capture-pane wrapper)
- [ ] ANSI code stripping
- [ ] SQLite message relay
- [ ] Basic config loader
- [ ] MCP client configuration for Claude Code
- [ ] MCP client configuration for Gemini CLI (verify support)

**Success Criteria:**
- Run Claude in tmux session "claude"
- Run Gemini in tmux session "gemini"
- From Gemini: call `get_agent_output("claude")` and receive clean output

### Phase 2: Bidirectional Communication
**Goal:** Agents can send messages to each other

**Deliverables:**
- [ ] `send_to_agent` tool (tmux send-keys wrapper)
- [ ] Message threading in relay DB
- [ ] Read receipts / acknowledgments
- [ ] Rate limiting

### Phase 3: Rich Context
**Goal:** Smart context handling for better agent comprehension

**Deliverables:**
- [x] Output parser (detect tool calls, code blocks)
- [x] Agent state detection (idle, working, waiting)
- [x] **Phase 3.2:** Rate Limiting & Caching (implemented 30s tool cache to save tokens)
- [ ] **Phase 3.3:** Summarization for long outputs

### Phase 4: Multi-Agent Orchestration (The "Hive" Protocol)
**Goal:** Autonomous execution of high-level Operator tasks via Director/Worker topology.

**Target Topology:**
- **Operator:** Human issuer of intent.
- **Agent (Gemini):** Orchestrator. Decomposes tasks, assigns subtasks, reviews work, reports status.
- **Workers (Claude, Codex, etc.):** Executors. Receive tasks, perform actions, report back.

**Deliverables:**
- [x] **Team Protocol v1.0:** TASK_ASSIGN, TASK_ACCEPT, TASK_COMPLETE flow.
- [x] **Communication Governance:** Mandatory busy-checks, C-c interrupts, and C-m verification.
- [x] **Token Optimization:** 30s polling and 30s terminal capture caching.
- [ ] **Dynamic Scaling:** Ability for Director to spin up new agents on demand.
- [ ] **Consensus/Voting:** Mechanism for multiple agents to deliberate on a solution.
- [ ] **Session Persistence:** Long-running states that survive restarts.

---

## Technical Decisions

### Why tmux?
- Already running agents in terminals
- `capture-pane` is reliable and fast
- No modifications needed to agent runtimes
- Works with any CLI agent

### Why SQLite for Relay?
- Zero infrastructure
- Single file, portable
- Good enough for local development
- Easy to inspect/debug

### Why FastMCP (Python)?
- First-class MCP support
- Quick iteration
- Easy subprocess calls to tmux

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Gemini CLI MCP support unclear | Blocks half the use case | Verify early, pivot to polling if needed |
| Large outputs blow context | Poor agent comprehension | Implement summarization in Phase 3 |
| tmux not available | Entire approach fails | Fallback to `script` command or file-based |
| ANSI parsing incomplete | Garbled output | Use robust library (e.g., strip-ansi) |

---

## Success Metrics

- **P1:** Gemini successfully retrieves and comments on Claude output
- **P2:** Bidirectional conversation possible
- **P3:** Agents can work on shared codebase with awareness
- **P4:** Autonomous multi-agent task execution

---

*Last updated: 2026-01-23*
