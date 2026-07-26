# zeos is retired (2026-07-26)

zeos (the memory/context OS for AI agents) was retired and unwired from its host machine on 2026-07-26. This repository is archived as the historical record; nothing in it should be installed or executed.

What replaced each function:

- Context continuity across sessions and compactions: compact-net (the compaction-continuity hook chain, an official skill in the skills repo).
- Session closure and journaling (/snap, /end): /closeout, auto-memory, and compact-net recovery bundles.
- Multi-agent coordination (zeos-lane): the standalone lane binary (state under ~/.lane); the frozen legacy claim record remains readable under ~/.zeos/coordination.
- Orchestration (overseer, /team): FlagDeck (fleet board, orchestrator ranks, succession, operator bus).
- Project boot (/project, /zeos): direct file reads driven by each project's own CLAUDE.md load procedure.
- Compaction hooks (precompact-snap, compact-reorient): compact-net superseded both; the machine's hook registrations were removed 2026-07-23.

The ~/.zeos state tree (memory ledgers, journals, souls, registry) remains LIVE DATA at its legacy location until the flagdeck-consolidation campaign migrates it; retiring this runtime did not touch it. The installer at tools/install.sh is permanently disabled with a refusal guard because it would re-wire retired hooks, MCP registrations, and skills.

Unmerged feature branches (feat/pairloop-scaffold, feat/project-boot-mode) are preserved in this archive and retrievable if ever needed.
