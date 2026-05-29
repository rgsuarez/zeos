#!/usr/bin/env node
/**
 * Inject - zeos Context Injection MCP Server
 *
 * Part of zeos infrastructure. Provides efficient boot payloads.
 * Reduces 8-10 file reads to 1-2 MCP tool calls.
 *
 * Version: 1.0.0
 * Location: ~/projects/zeos/infrastructure/inject/
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ZEOS_REPO_ROOT,
  ZEOS_STATE_ROOT,
  ZEOS_APPS_ROOT,
  stateFirst,
  expandPath as resolverExpandPath,
  resolveJournalPath as resolverResolveJournalPath,
  resolveMemoryPath as resolverResolveMemoryPath,
  resolveSoulPath as resolverResolveSoulPath,
  resolveRoadmapPath as resolverResolveRoadmapPath,
  resolveProjectClaudeMdPath as resolverResolveProjectClaudeMdPath,
  resolveProjectRoot as resolverResolveProjectRoot,
  verifyJournalWritten,
} from "./path-resolver.js";
import {
  redactSensitiveText,
  mergeRedactions,
  formatRedactionNotice,
  type RedactionResult,
} from "./lib/redact.js";
import {
  buildBridgeContent,
  normalizeTags,
  normalizeStringList,
  clampImportance,
  formatListSection,
  titleFromSummary,
  stripListMarker,
  firstContentLine,
  detectToolGrammarLeak,
  buildErrorEnvelope,
  buildToolGrammarLeakResponse,
  type BridgeSections,
} from "./lib/bridge.js";
import {
  MEMORY_ENTRY_DECAY_DEFAULT,
  MEMORY_ENTRY_IMPORTANCE_DEFAULT,
  MEMORY_PROMOTION_IMPORTANCE_THRESHOLD,
  parseMemoryMd,
  formatMemoryMd,
  formatMemoryEntryContent,
  ageMemoryEntries,
  curateMemory,
  memoryRetentionScore,
  getMemoryTokenLimit as _getMemoryTokenLimitFromContent,
  estimateTokens,
  formatEntryHeading,
  parseEntryHeadingTail,
  type MemoryEntry,
  type ParsedMemory,
} from "./lib/memory.js";
import {
  extractJournalSummary,
  getLatestJournal,
  createJournalStub as _createJournalStubLib,
  checkParallelInstances,
  JOURNAL_SCHEMA_VERSION,
} from "./lib/journal.js";
import { getGitSnapshot as _getGitSnapshotByPath } from "./lib/git-snapshot.js";
import {
  parseDigestFromMemory,
  formatCarryForwardBlock,
  type ContinuityDigest,
} from "./lib/digest.js";
import { findMemoryByTags } from "./lib/memory-find.js";
import { promoteMemoryEntryToSoul } from "./lib/soul-promote.js";

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

// Product paths (kernel, modules, profiles/template) resolve under the repo
// root; operator state (registry, profiles, souls, memory, journals, roadmaps)
// resolves under the state root (~/.zeos as of v1.2.0). The registry read is
// state-first with a one-release legacy fallback to the old in-repo location.
const REGISTRY_PATH = stateFirst(
  `${ZEOS_STATE_ROOT}/apps/REGISTRY.json`,
  `${ZEOS_REPO_ROOT}/apps/REGISTRY.json`,
);
const DEFAULT_PROFILE = "operator";
// JOURNAL_SCHEMA_VERSION, MEMORY_ENTRY_DECAY_DEFAULT, MEMORY_ENTRY_IMPORTANCE_DEFAULT,
// MEMORY_PROMOTION_IMPORTANCE_THRESHOLD are imported from src/lib/journal.ts and src/lib/memory.ts.

// Session registry: maps "project_id::agent" -> journal filename.
// Uses compound key to support parallel agents on same project even when
// MCP processes are shared (e.g., single MCP server serving multiple sessions).
// Ensures /snap and /end target the correct journal for each agent.
const _activeJournals: Record<string, string> = {};

// Agent registry: maps project_id -> agent name for this session.
// Set at project load, used by /snap and /end when agent param not provided.
// Enables automatic agent resolution without requiring explicit agent param.
const _sessionAgents: Record<string, string> = {};

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

const expandPath = resolverExpandPath;

function readFile(filePath: string): string {
  const expanded = expandPath(filePath);
  try {
    return fs.readFileSync(expanded, "utf-8");
  } catch (e) {
    return `<!-- FILE_NOT_FOUND: ${filePath} -->`;
  }
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(expandPath(filePath));
}

// Resolve an operator profile: state-side first (~/.zeos/profiles/<name>/),
// then the legacy in-repo profile (one-release fallback), then the in-repo
// template as the final default. Product template stays in the repo.
function resolveProfilePath(name: string): string {
  const stateP = `${ZEOS_STATE_ROOT}/profiles/${name}/PROFILE.md`;
  const repoP = `${ZEOS_REPO_ROOT}/profiles/${name}/PROFILE.md`;
  if (fileExists(stateP)) return stateP;
  if (fileExists(repoP)) return repoP;
  return `${ZEOS_REPO_ROOT}/profiles/template/PROFILE.md`;
}

function readJson(filePath: string): any {
  try {
    const content = readFile(filePath);
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// FILESYSTEM LOCK (for MEMORY.md concurrent writes)
// ═══════════════════════════════════════════════════════════════

const LOCK_STALE_MS = 30_000;  // 30s — auto-remove orphaned locks
const LOCK_RETRY_MAX = 5;
const LOCK_RETRY_BASE_MS = 500;

function acquireMemoryLock(memoryPath: string): boolean {
  const lockPath = memoryPath + '.lock';
  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    try {
      // O_CREAT|O_EXCL — atomic create, fails if lock exists
      fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' });
      return true;
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        // Lock held — check if stale
        try {
          const lockContent = fs.readFileSync(lockPath, 'utf-8');
          const lockTime = new Date(lockContent.split('\n')[1]).getTime();
          if (Date.now() - lockTime > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);  // Remove stale lock
            continue;  // Retry immediately
          }
        } catch { /* lock file unreadable — treat as stale */
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
        // Lock is fresh — wait with jitter and retry
        const jitter = LOCK_RETRY_BASE_MS + Math.floor(Math.random() * 500);
        const { execSync } = require('child_process');
        execSync(`sleep ${jitter / 1000}`);
        continue;
      }
      throw e;  // Unexpected error
    }
  }
  return false;  // Could not acquire after retries
}

function releaseMemoryLock(memoryPath: string): void {
  const lockPath = memoryPath + '.lock';
  try { fs.unlinkSync(lockPath); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// MEMORY CURATION UTILITIES (extracted to src/lib/memory.ts)
// ═══════════════════════════════════════════════════════════════

// Wrapper preserving the original profile-name signature; reads the profile
// file via the existing helper, then delegates parsing to the pure lib helper.
function getMemoryTokenLimit(profileName: string = DEFAULT_PROFILE): number {
  const profilePath = resolveProfilePath(profileName);
  return _getMemoryTokenLimitFromContent(readFile(profilePath));
}

function generateContinuityDigest(
  journalDir: string,
  currentSummary: string,
  nextActions: string,
  finalBridge: string = ""
): ContinuityDigest {
  const expanded = expandPath(journalDir);
  const digest: ContinuityDigest = {
    lastSessions: [],
    openThreads: [],
    decisions: [],
    nextActions: []
  };

  // Get last 3 journals for session history
  if (fs.existsSync(expanded)) {
    const journals = fs.readdirSync(expanded)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 3);

    for (const journal of journals) {
      const content = fs.readFileSync(path.join(expanded, journal), 'utf-8');
      const dateMatch = journal.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const summaryText = extractJournalSummary(content);
        const summary = summaryText
          ? summaryText.split('\n')[0].substring(0, 120)
          : journal.replace('.md', '');
        digest.lastSessions.push(`${dateMatch[1]}: ${summary}`);
      }
    }
  }

  // Extract open threads from nextActions and the final bridge.
  const actionLines = `${nextActions}\n${finalBridge}`.split('\n');
  for (const line of actionLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- [ ]') || trimmed.toLowerCase().includes('todo')) {
      digest.openThreads.push(stripListMarker(trimmed));
    } else if (trimmed.startsWith('-') || trimmed.startsWith('*') || trimmed.match(/^\d+[\.)]/)) {
      digest.nextActions.push(stripListMarker(trimmed));
    }
  }

  // If no structured actions, use the whole nextActions as a single item
  if (digest.nextActions.length === 0 && nextActions.trim()) {
    digest.nextActions.push(nextActions.trim().split('\n')[0]);
  }

  // Extract decisions from summary (lines with decision-indicating keywords)
  const summaryLines = `${currentSummary}\n${finalBridge}`.split('\n');
  for (const line of summaryLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // Skip headings and empty lines
    const lower = trimmed.toLowerCase();
    // Require stronger decision signals to reduce false positives
    if (lower.includes('decided') || lower.includes('decision:') ||
        lower.match(/\bwill (use|adopt|implement|migrate|switch|require|enforce)\b/) ||
        lower.match(/\bmust (be|have|use|always)\b/) ||
        lower.includes('chose ') || lower.includes('chosen ')) {
      digest.decisions.push(trimmed.substring(0, 200));
    }
  }

  return digest;
}

function formatContinuityDigest(digest: ContinuityDigest): string {
  let output = '## Continuity Digest\n\n';

  output += '### Last 3 Sessions\n';
  if (digest.lastSessions.length > 0) {
    output += digest.lastSessions.map(s => `- ${s}`).join('\n') + '\n';
  } else {
    output += '*No prior sessions*\n';
  }

  output += '\n### Open Threads\n';
  if (digest.openThreads.length > 0) {
    output += digest.openThreads.map(t => `- [ ] ${t}`).join('\n') + '\n';
  } else {
    output += '*None*\n';
  }

  output += '\n### Decisions/Constraints\n';
  if (digest.decisions.length > 0) {
    output += digest.decisions.map(d => `- ${d}`).join('\n') + '\n';
  } else {
    output += '*None this session*\n';
  }

  output += '\n### Next Actions\n';
  if (digest.nextActions.length > 0) {
    output += digest.nextActions.map((a, i) => `${i + 1}. ${a}`).join('\n') + '\n';
  } else {
    output += '*None specified*\n';
  }

  output += '\n---\n\n';
  return output;
}


// ═══════════════════════════════════════════════════════════════
// REGISTRY-BASED PROJECT LOOKUP
// ═══════════════════════════════════════════════════════════════

interface AppEntry {
  app_id: string;
  name: string;
  type: string;
  status: string;
  repo?: { url?: string; branch?: string; clone_path?: string };
  local_path: string;
  soul_file?: string;
  journal_location?: string;
  journal_prefix?: string;
  aws_account?: string;
  aws_region?: string;
  capabilities?: string[];
  infrastructure?: any;
  modules?: string[];
  note?: string;
}

function loadRegistry(): AppEntry[] {
  const registry = readJson(REGISTRY_PATH);
  if (!registry || !registry.apps) {
    console.error("Failed to load REGISTRY.json");
    return [];
  }
  return registry.apps;
}

function findProject(projectName: string): AppEntry | null {
  const apps = loadRegistry();
  const normalized = projectName.toLowerCase().replace(/\s+/g, '-');

  // Try exact match first
  let found = apps.find(a => a.app_id === normalized);
  if (found) return found;

  // Try partial match
  found = apps.find(a => a.app_id.includes(normalized) || a.name.toLowerCase().includes(normalized));
  return found || null;
}

function resolveJournalPath(app: AppEntry): string {
  return resolverResolveJournalPath(app);
}

function resolveMemoryPath(app: AppEntry): string {
  return resolverResolveMemoryPath(app);
}

function resolveSoulPath(app: AppEntry): string {
  return resolverResolveSoulPath(app);
}

function resolveProjectClaudeMdPath(app: AppEntry): string {
  return resolverResolveProjectClaudeMdPath(app);
}

function resolveProjectRoot(app: AppEntry): string {
  return resolverResolveProjectRoot(app);
}

// ═══════════════════════════════════════════════════════════════
// THREE-TIER MEMORY SYSTEM
// ═══════════════════════════════════════════════════════════════

interface MemoryPayload {
  tier1_synopsis: string;      // Rolling 30-day summary
  tier2_sessions: string[];    // Last 3 session summaries
  tier3_current: string;       // Current session
}

function loadMemory(journalDir: string, memoryFilePath?: string): MemoryPayload {
  const expanded = expandPath(journalDir);

  // Tier 1: Load MEMORY.md (consolidated synopsis)
  // Caller may pass an explicit MEMORY.md path; otherwise default to the
  // pre-v1.2.0 convention (one level up from journal dir) for back-compat.
  const memoryPath = memoryFilePath
    ? expandPath(memoryFilePath)
    : path.join(expanded, "..", "MEMORY.md");
  let tier1 = "";
  if (fs.existsSync(memoryPath)) {
    tier1 = fs.readFileSync(memoryPath, "utf-8");
  }

  // Tier 2: Load last 3 session summaries (skip empty stubs)
  const tier2: string[] = [];
  if (fs.existsSync(expanded)) {
    const allFiles = fs.readdirSync(expanded)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    for (const file of allFiles) {
      if (tier2.length >= 3) break;

      const content = fs.readFileSync(path.join(expanded, file), "utf-8");
      // Skip empty stubs (frontmatter-only journals with no real content)
      const withoutFrontmatter = content.replace(/^---[\s\S]*?---\s*/, '');
      if (withoutFrontmatter.trim().length < 50) continue;

      // Multi-pattern summary extraction (handles all journal eras)
      const summary = extractJournalSummary(content);
      if (summary) {
        tier2.push(`**${file}:**\n${summary}`);
      } else {
        // Fallback: use substantive content (checkpoints, deltas, etc.)
        tier2.push(`**${file}:**\n${withoutFrontmatter.trim().substring(0, 1000)}`);
      }
    }
  }

  // Tier 3: Full current session (handled separately in boot)
  return { tier1_synopsis: tier1, tier2_sessions: tier2, tier3_current: "" };
}

// Journal helpers (getLatestJournal, createJournalStub, checkParallelInstances)
// are imported from src/lib/journal.ts. We keep a thin wrapper around
// createJournalStub so the existing 3-arg call sites stay unchanged while the
// lib supports an optional 4th carry-forward arg used in Phase 2.
function createJournalStub(journalDir: string, agentName: string, app?: AppEntry): string {
  return _createJournalStubLib(journalDir, agentName, app ?? null, "");
}

// getGitSnapshot is imported from src/lib/git-snapshot.ts. The lib takes a
// pre-resolved repo path; we use the existing resolveProjectRoot from
// path-resolver.ts (which honors clone_path, repo.url, and legacy local_path).
function getGitSnapshot(app: AppEntry): string {
  return _getGitSnapshotByPath(expandPath(resolveProjectRoot(app)));
}

// ═══════════════════════════════════════════════════════════════
// BOOT PAYLOAD COMPILATION
// ═══════════════════════════════════════════════════════════════

function compileBootPayload(profile: string = DEFAULT_PROFILE): string {
  const profilePath = resolveProfilePath(profile);

  // Load profile and check boot mode
  let profileContent = readFile(profilePath);

  // LEAN IS DEFAULT - only load full if explicitly set to "full"
  const isFullMode = profileContent.includes('boot_mode: full');

  // Truncate profile (remove fleet table - it's in REGISTRY.json)
  const fleetIndex = profileContent.indexOf('## Fleet');
  if (fleetIndex !== -1) {
    profileContent = profileContent.substring(0, fleetIndex) +
      '## Fleet\n\nUse `/fleet` or `zeos_fleet` tool to view project portfolio.\n\n---\n';
  }

  // Load kernel based on mode
  let soul: string;
  let bootProtocol: string;
  let shellProtocol: string;

  if (isFullMode) {
    // FULL BOOT - explicit only
    soul = readFile(`${ZEOS_REPO_ROOT}/kernel/SOUL.md`);
    bootProtocol = readFile(`${ZEOS_REPO_ROOT}/kernel/BOOT_PROTOCOL.md`);
    // The canonical full-boot shell protocol is the numbered module file;
    // the old unnumbered SHELL_PROTOCOL.md path never existed on disk.
    shellProtocol = readFile(`${ZEOS_REPO_ROOT}/modules/constraints/ZEOS_MODULE_002_SHELL_PROTOCOL.md`);
  } else {
    // LEAN BOOT - default
    soul = readFile(`${ZEOS_REPO_ROOT}/kernel/lean/SOUL_CORE.md`);
    bootProtocol = readFile(`${ZEOS_REPO_ROOT}/kernel/lean/BOOT_PROTOCOL_LEAN.md`);
    shellProtocol = readFile(`${ZEOS_REPO_ROOT}/kernel/lean/SHELL_PROTOCOL_LEAN.md`);
  }

  const payload = `
═══════════════════════════════════════════════════════════════

    ███████ ████████  ███████  ██████
       ███  ██       ██    ██ ██
      ███   ██████   ██    ██  █████
     ███    ██       ██    ██      ██
    ███████ ████████  ███████  ██████

    Operating System for AI Collaboration
    Persistence Protocol Active

    Profile: ${profile}
    Boot Mode: ${isFullMode ? 'FULL' : 'LEAN (default)'}
    Injected via: zeos Inject MCP v1.0.0

═══════════════════════════════════════════════════════════════

# KERNEL: SOUL

${soul}

---

# KERNEL: BOOT_PROTOCOL

${bootProtocol}

---

# MODULE: SHELL_PROTOCOL

${shellProtocol}

---

# PROFILE: ${profile}

${profileContent}

---

**zeos is now ACTIVE.** Use \`/project <name>\` or \`zeos_load_project\` to load a project.
`;

  return payload;
}

// ═══════════════════════════════════════════════════════════════
// PROJECT PAYLOAD COMPILATION
// ═══════════════════════════════════════════════════════════════

function compileProjectPayload(projectName: string, agentName: string = "claude"): string {
  const app = findProject(projectName);

  if (!app) {
    return `
═══════════════════════════════════════════════════════════════
ERROR: Project not found: ${projectName}
═══════════════════════════════════════════════════════════════

Available projects (from REGISTRY.json):
${loadRegistry().map(a => `- ${a.app_id}: ${a.name}`).join('\n')}

Use one of the above project IDs.
`;
  }

  const journalDir = resolveJournalPath(app);
  const soulPath = resolveSoulPath(app);
  const claudeMdPath = resolveProjectClaudeMdPath(app);

  // Check for parallel instances
  const activeInstances = checkParallelInstances(journalDir);
  let parallelWarning = "";
  if (activeInstances.length > 0) {
    parallelWarning = `
⚠️ PARALLEL INSTANCE DETECTION ⚠️
Active agents on this project today: ${activeInstances.join(', ')}
Coordinate to avoid conflicts.

`;
  }

  // IMPORTANT: Load memory and latest journal BEFORE creating stub.
  // Otherwise the newly created empty stub becomes the "latest" journal.

  // Load project files:
  // - SOUL.md (state-side): identity, mission, constraints (WHO)
  // - MASTER_ROADMAP.md (state-side, optional): development direction
  // - Project CLAUDE.md (project repo, optional) — operations doctrine (HOW)
  const soul = readFile(soulPath);
  // v1.2.0: master roadmap lives at ~/.zeos/roadmaps/<app_id>/MASTER_ROADMAP.md.
  // Surface it at boot between SOUL and memory. Silent-skip when absent (not
  // every project has one yet). Read once; reused for active-blueprint detection.
  const masterRoadmapPath = resolverResolveRoadmapPath(app);
  const masterRoadmap = fileExists(masterRoadmapPath) ? readFile(masterRoadmapPath) : "";
  const masterRoadmapSection = masterRoadmap
    ? `\n# Master Roadmap (MASTER_ROADMAP.md)\n\n${masterRoadmap}\n\n---\n`
    : "";
  const expandedClaudeMd = expandPath(claudeMdPath);
  const projectClaudeMd = fs.existsSync(expandedClaudeMd)
    ? fs.readFileSync(expandedClaudeMd, "utf-8")
    : "";

  // Load three-tier memory. MEMORY.md lives at ~/.zeos/memory/<app_id>/MEMORY.md.
  const memoryPath = resolveMemoryPath(app);
  const memory = loadMemory(journalDir, memoryPath);

  // Parse the prior session's Continuity Digest out of MEMORY.md (if present)
  // so we can both render it above SOUL and seed the new journal stub with it.
  const digest = parseDigestFromMemory(memory.tier1_synopsis || "");
  const carryForwardSection = digest
    ? `\n---\n\n${formatCarryForwardBlock(digest)}\n`
    : "";

  // Get latest full journal for current session context (BEFORE stub creation)
  const latestJournal = getLatestJournal(journalDir);

  // NOW create journal stub (after reading previous state). Seed it with the
  // carry-forward block when a digest exists; pass empty string otherwise so
  // the stub stays byte-equivalent to the Phase 1 default shape.
  const journalStub = _createJournalStubLib(
    journalDir,
    agentName,
    app ?? null,
    digest ? formatCarryForwardBlock(digest) : ""
  );

  // Register this journal for the session — compound key ensures /snap and /end
  // target THIS agent's journal even when multiple agents work on same project.
  const sessionKey = `${app.app_id}::${agentName}`;
  _activeJournals[sessionKey] = journalStub;

  // Also register agent name for this project — enables /snap and /end to
  // auto-resolve agent without requiring explicit param every call.
  _sessionAgents[app.app_id] = agentName;

  // Build memory section. Strip the Continuity Digest from the tier-1 rendering
  // because it's now rendered above SOUL as `carryForwardSection`; we don't want
  // it duplicated inside the Long-Term Memory block.
  const tier1WithoutDigest = (memory.tier1_synopsis || "").replace(
    /## Continuity Digest\n[\s\S]*?(?=\n## \d{4}|\n---\n|$)/,
    ""
  );

  let memorySection = "";

  if (tier1WithoutDigest.trim()) {
    memorySection += `
# Long-Term Memory (MEMORY.md)

${tier1WithoutDigest}

---
`;
  }

  if (memory.tier2_sessions.length > 0) {
    memorySection += `
# Recent Sessions (Last 3)

${memory.tier2_sessions.join('\n\n')}

---
`;
  }
  const journalSection = latestJournal
    ? `# Latest Session Journal\n\n${latestJournal}`
    : "[No prior session journals]";

  // Check for an active blueprint declared in the (state-side) master roadmap.
  // The roadmap content was already read above; reuse it. Blueprint files
  // remain under the legacy ZEOS_APPS_ROOT location (out of scope for v1.2.0).
  let blueprintSection = "";
  if (masterRoadmap) {
    const bpMatch = masterRoadmap.match(/active_blueprint:\s*"?([^"\n]+)"?/);
    if (bpMatch && bpMatch[1] !== "null") {
      const bpPath = `${ZEOS_APPS_ROOT}/${app.local_path}blueprints/${bpMatch[1]}`;
      if (fileExists(bpPath)) {
        blueprintSection = `\n---\n\n# Active Blueprint: ${bpMatch[1]}\n\n${readFile(bpPath)}`;
      }
    }
  }

  // Get git status
  let gitStatus = "";
  const repoPath = resolveProjectRoot(app);
  const expandedRepo = expandPath(repoPath);
  if (fs.existsSync(expandedRepo) && fs.existsSync(path.join(expandedRepo, '.git'))) {
    try {
      const { execSync } = require('child_process');
      const status = execSync('git status --short', { cwd: expandedRepo, encoding: 'utf-8' });
      if (status.trim()) {
        gitStatus = `\n## Git Status\n\n\`\`\`\n${status}\`\`\`\n`;
      }
    } catch (e) {
      // Ignore git errors
    }
  }

  const payload = `
┌─────────────────────────────────────────────────────────────┐
│ PROJECT: ${app.name.padEnd(47)} │
│ ID: ${app.app_id.padEnd(52)} │
│ Type: ${app.type.padEnd(50)} │
│ Status: ${app.status.padEnd(48)} │
│ Journal: ${journalStub.padEnd(47)} │
└─────────────────────────────────────────────────────────────┘

${parallelWarning}${carryForwardSection}# Project SOUL

${soul || `_(no SOUL.md found at ${soulPath} — scaffold with \`/newproject\` or write one manually)_`}
${projectClaudeMd ? `
---

# Project CLAUDE.md (operations doctrine)

${projectClaudeMd}
` : ""}
${masterRoadmapSection}${gitStatus}
---
${memorySection}
${journalSection}
${blueprintSection}

---

**Project ${app.name} loaded.** Journal: ${journalStub}
`;

  return payload;
}

// ═══════════════════════════════════════════════════════════════
// MCP SERVER
// ═══════════════════════════════════════════════════════════════

const server = new Server(
  {
    name: "zeos-inject",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "zeos_boot",
      description: "Boot zeos operating system. Returns compiled kernel + profile. LEAN boot is default. Call when user says /zeos or 'boot zeos'.",
      inputSchema: {
        type: "object" as const,
        properties: {
          profile: {
            type: "string",
            description: "Profile name (default: operator)",
            default: DEFAULT_PROFILE
          }
        }
      }
    },
    {
      name: "zeos_load_project",
      description: "Load a zeos project. Auto-boots zeos if not already loaded. Returns project SOUL + project CLAUDE.md (operations doctrine, if present) + three-tier memory (MEMORY.md synopsis + recent sessions + latest journal). Call when user says /project <name>.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project ID from REGISTRY.json (e.g., example-project, zeos-dev, blueprint)"
          },
          agent: {
            type: "string",
            description: "Agent identifier for journal (default: claude)",
            default: "claude"
          }
        },
        required: ["project"]
      }
    },
    {
      name: "zeos_fleet",
      description: "Get portfolio overview from REGISTRY.json. Call when user says /fleet.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filter: {
            type: "string",
            description: "Filter by status: active, hibernated, all (default: all)"
          }
        }
      }
    },
    {
      name: "zeos_snap",
      description: "Save progress snapshot to session journal. Call when user says /snap.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project ID"
          },
          delta: {
            type: "string",
            description: "Backward-compatible free-form bridge content"
          },
          objective: {
            type: "string",
            description: "Current mission in one sentence"
          },
          state: {
            type: "string",
            description: "What is true right now"
          },
          open_threads: {
            type: "array",
            items: { type: "string" },
            description: "Pending work, blockers, or unresolved questions"
          },
          verified: {
            type: "array",
            items: { type: "string" },
            description: "Facts, tests, or checks verified this session"
          },
          assumed: {
            type: "array",
            items: { type: "string" },
            description: "Assumptions still requiring verification"
          },
          blockers: {
            type: "array",
            items: { type: "string" },
            description: "Items blocking forward progress"
          },
          dead_ends: {
            type: "array",
            items: { type: "string" },
            description: "Approaches tried and rejected"
          },
          next_tactical_move: {
            type: "string",
            description: "First action a cold next session should take"
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Retrieval tags for this checkpoint"
          },
          note: {
            type: "string",
            description: "Optional snapshot note"
          },
          agent: {
            type: "string",
            description: "Agent identifier for journal targeting (default: claude)"
          }
        },
        required: ["project"]
      }
    },
    {
      name: "zeos_end_session",
      description: "End session with summary and handoff. Updates MEMORY.md. Call when user says /end.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project ID"
          },
          summary: {
            type: "string",
            description: "Session summary for MEMORY.md"
          },
          title: {
            type: "string",
            description: "Optional MEMORY.md entry title"
          },
          delta: {
            type: "string",
            description: "Backward-compatible final bridge"
          },
          objective: {
            type: "string",
            description: "Current mission in one sentence"
          },
          state: {
            type: "string",
            description: "What is true at session close"
          },
          open_threads: {
            type: "array",
            items: { type: "string" },
            description: "Pending work, blockers, or unresolved questions"
          },
          verified: {
            type: "array",
            items: { type: "string" },
            description: "Facts, tests, or checks verified this session"
          },
          assumed: {
            type: "array",
            items: { type: "string" },
            description: "Assumptions still requiring verification"
          },
          blockers: {
            type: "array",
            items: { type: "string" },
            description: "Items blocking forward progress"
          },
          dead_ends: {
            type: "array",
            items: { type: "string" },
            description: "Approaches tried and rejected"
          },
          next_tactical_move: {
            type: "string",
            description: "First action a cold next session should take"
          },
          nextActions: {
            type: "string",
            description: "Handoff for next session"
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Retrieval tags for MEMORY.md"
          },
          importance: {
            type: "number",
            description: "Durable value from 1 to 5. 4 or 5 surfaces as SOUL promotion candidate."
          },
          why: {
            type: "string",
            description: "Why this memory matters"
          },
          how_to_apply: {
            type: "string",
            description: "How future sessions should use this memory"
          },
          refs: {
            type: "array",
            items: { type: "string" },
            description: "Optional references such as paths, SHAs, PRs, or docs"
          },
          agent: {
            type: "string",
            description: "Agent identifier for journal targeting (default: claude)"
          }
        },
        required: ["project", "summary", "nextActions"]
      }
    },
    {
      name: "zeos_help",
      description: "Get zeos help.",
      inputSchema: {
        type: "object" as const,
        properties: {
          command: {
            type: "string",
            description: "Specific command (optional)"
          }
        }
      }
    },
    {
      name: "zeos_parallel",
      description: "Check for parallel instances on a project.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project ID"
          }
        },
        required: ["project"]
      }
    },
    {
      name: "zeos_memory_curate",
      description: "Manually curate project MEMORY.md. Actions: stats, merge, delete, promote, pin, unpin, list, find.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project ID"
          },
          action: {
            type: "string",
            description: "Action: stats, merge, delete, promote, pin, unpin, list, find"
          },
          args: {
            type: "string",
            description: "Action arguments. For find: comma-separated tags (AND semantics). For merge: dates."
          }
        },
        required: ["project", "action"]
      }
    },
    {
      name: "zeos_soul_promote",
      description: "Promote an ACTIVE MEMORY.md entry to SOUL.md under a specified section. Writes a title pointer line plus the Why and How to Apply sections only (Summary body stays in MEMORY; archived entries are not promotable, surface them with /memory-curate first). Defaults to dry_run=true and returns a preview without writing. Pass dry_run=false to commit. On commit, marks the source MEMORY entry [promoted:true] (durable model-level marker). Idempotent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project ID"
          },
          entry_date: {
            type: "string",
            description: "Date of the MEMORY entry to promote (YYYY-MM-DD)"
          },
          entry_title: {
            type: "string",
            description: "Required when multiple entries share a date; otherwise optional disambiguator"
          },
          section: {
            type: "string",
            description: "SOUL.md section heading (e.g., Constraints, Values, Mission)"
          },
          dry_run: {
            type: "boolean",
            description: "When true (default), return preview without writing. Pass false to commit."
          }
        },
        required: ["project", "entry_date", "section"]
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "zeos_boot": {
        const profile = (args?.profile as string) || DEFAULT_PROFILE;
        const payload = compileBootPayload(profile);
        return { content: [{ type: "text", text: payload }] };
      }

      case "zeos_load_project": {
        const project = args?.project as string;
        const agent = (args?.agent as string) || "claude";

        if (!project) {
          return { content: [{ type: "text", text: "Error: project is required" }], isError: true };
        }

        const payload = compileProjectPayload(project, agent);
        return { content: [{ type: "text", text: payload }] };
      }

      case "zeos_fleet": {
        const filter = (args?.filter as string) || "all";
        const apps = loadRegistry();

        const filtered = filter === "all"
          ? apps
          : apps.filter(a => a.status === filter);

        // Group by type
        const byType: Record<string, AppEntry[]> = {};
        for (const app of filtered) {
          if (!byType[app.type]) byType[app.type] = [];
          byType[app.type].push(app);
        }

        const statusIcon: Record<string, string> = {
          'active': '🟢',
          'hibernated': '💤',
          'deprecated': '⛔'
        };

        let output = `
┌─────────────────────────────────────────────────────────────┐
│ zeos FLEET — Portfolio Overview                             │
│ Filter: ${filter.padEnd(51)} │
│ Projects: ${String(filtered.length).padEnd(49)} │
└─────────────────────────────────────────────────────────────┘

`;

        for (const [type, projectList] of Object.entries(byType)) {
          output += `## ${type.toUpperCase()} (${projectList.length})\n\n`;
          for (const app of projectList) {
            const icon = statusIcon[app.status] || '⚪';
            output += `- ${icon} **${app.app_id}** — ${app.name}`;
            if (app.note) output += ` — ${app.note.substring(0, 60)}...`;
            output += '\n';
          }
          output += '\n';
        }

        output += "---\n*Use `/project <id>` to load context.*\n";

        return { content: [{ type: "text", text: output }] };
      }

      case "zeos_snap": {
        const leak = detectToolGrammarLeak(args as Record<string, unknown> | undefined);
        if (leak) {
          return {
            content: [{ type: "text", text: buildToolGrammarLeakResponse(leak) }],
            isError: true,
          };
        }
        const project = args?.project as string;
        const delta = (args?.delta as string) || "";
        const note = (args?.note as string) || "";
        const tags = normalizeTags(args?.tags);
        const bridge = buildBridgeContent({
          objective: args?.objective as string,
          state: args?.state as string,
          openThreads: normalizeStringList(args?.open_threads),
          verified: normalizeStringList(args?.verified),
          assumed: normalizeStringList(args?.assumed),
          blockers: normalizeStringList(args?.blockers),
          deadEnds: normalizeStringList(args?.dead_ends),
          nextTacticalMove: args?.next_tactical_move as string,
          delta
        });

        if (!project || !bridge) {
          const missing: string[] = [];
          if (!project) missing.push("project");
          if (!bridge) missing.push("bridge content (delta or one of objective/state/open_threads/verified/assumed/blockers/dead_ends/next_tactical_move)");
          return {
            content: [{
              type: "text",
              text: buildErrorEnvelope({
                error_code: "ZEOS_MISSING_REQUIRED",
                error: "Missing required fields for zeos_snap.",
                missing_fields: missing,
                hint: "Provide `project` plus at least one bridge-content field (`delta` is the catch-all).",
                expected_shape: {
                  project: "string (required)",
                  delta: "string (catch-all bridge content; required if no structured fields provided)",
                  objective: "string (optional)",
                  next_tactical_move: "string (optional)",
                },
              }),
            }],
            isError: true,
          };
        }

        const app = findProject(project);
        if (!app) {
          return {
            content: [{
              type: "text",
              text: buildErrorEnvelope({
                error_code: "ZEOS_PROJECT_NOT_FOUND",
                error: `Project not found: ${project}`,
                hint: "Check the project registry at apps/REGISTRY.json or run zeos_fleet to list known projects.",
                offending_field: "project",
                offending_sample: project,
              }),
            }],
            isError: true,
          };
        }

        // Auto-resolve agent from session registry, fallback to explicit param or default
        const agent = (args?.agent as string) || _sessionAgents[app.app_id] || "claude";

        const journalDir = resolveJournalPath(app);
        const expanded = expandPath(journalDir);
        const timestamp = new Date().toISOString();
        const date = timestamp.split('T')[0];

        // Find THIS agent's journal via session registry (compound key), fallback to filesystem scan
        const sessionKey = `${app.app_id}::${agent}`;
        let targetJournal: string | null = _activeJournals[sessionKey] || null;
        if (!targetJournal || !fs.existsSync(path.join(expanded, targetJournal))) {
          // Fallback: find this agent's journal from today (backward compat)
          const journals = fs.readdirSync(expanded)
            .filter((f: string) => f.startsWith(date) && f.includes(`-${agent}.md`))
            .sort()
            .reverse();
          // If no agent-specific journal, fall back to newest today
          if (journals.length === 0) {
            const allJournals = fs.readdirSync(expanded)
              .filter((f: string) => f.startsWith(date) && f.endsWith('.md'))
              .sort()
              .reverse();
            targetJournal = allJournals[0] || null;
          } else {
            targetJournal = journals[0];
          }
        }

        if (!targetJournal) {
          return {
            content: [{
              type: "text",
              text: buildErrorEnvelope({
                error_code: "ZEOS_NO_ACTIVE_JOURNAL",
                error: "No active journal found for this agent.",
                hint: "Run /project first with your project id to initialize a session journal for this agent.",
              }),
            }],
            isError: true,
          };
        }

        const journalPath = path.join(expanded, targetJournal);
        const gitSnapshot = getGitSnapshot(app);
        const redactedBridge = redactSensitiveText(bridge);
        const redactedNote = redactSensitiveText(note);
        const redactedGitSnapshot = redactSensitiveText(gitSnapshot);
        const redactions = mergeRedactions(redactedBridge, redactedNote, redactedGitSnapshot);

        const snapEntry = `
## Checkpoint: ${timestamp}

${redactedNote.text ? `**Note:** ${redactedNote.text}\n\n` : ''}${tags.length > 0 ? `**Tags:** ${tags.join(", ")}\n\n` : ''}### Bridge
${redactedBridge.text}

${redactedGitSnapshot.text ? `${redactedGitSnapshot.text}\n` : ''}
${formatRedactionNotice(redactions)}

---
`;

        fs.appendFileSync(journalPath, snapEntry);
        verifyJournalWritten(journalPath);

        const redactionSummary = redactions.count > 0
          ? ` (${redactions.count} sensitive value(s) redacted)`
          : "";
        return { content: [{ type: "text", text: `✓ Checkpoint saved to ${journalPath}${redactionSummary}` }] };
      }

      case "zeos_end_session": {
        const leak = detectToolGrammarLeak(args as Record<string, unknown> | undefined);
        if (leak) {
          return {
            content: [{ type: "text", text: buildToolGrammarLeakResponse(leak) }],
            isError: true,
          };
        }
        const project = args?.project as string;
        const summary = args?.summary as string;
        const title = (args?.title as string) || "";
        const delta = (args?.delta as string) || "";
        const nextActions = args?.nextActions as string;
        const tags = normalizeTags(args?.tags);
        const importance = clampImportance(args?.importance);
        const why = (args?.why as string) || "";
        const howToApply = (args?.how_to_apply as string) || "";
        const refs = normalizeStringList(args?.refs);
        const finalBridge = buildBridgeContent({
          objective: args?.objective as string,
          state: args?.state as string,
          openThreads: normalizeStringList(args?.open_threads),
          verified: normalizeStringList(args?.verified),
          assumed: normalizeStringList(args?.assumed),
          blockers: normalizeStringList(args?.blockers),
          deadEnds: normalizeStringList(args?.dead_ends),
          nextTacticalMove: args?.next_tactical_move as string,
          delta
        });

        if (!project || !summary || !finalBridge || !nextActions) {
          const missing: string[] = [];
          if (!project) missing.push("project");
          if (!summary) missing.push("summary");
          if (!finalBridge) missing.push("final bridge content (delta or one of objective/state/open_threads/verified/assumed/blockers/dead_ends/next_tactical_move)");
          if (!nextActions) missing.push("nextActions");
          return {
            content: [{
              type: "text",
              text: buildErrorEnvelope({
                error_code: "ZEOS_MISSING_REQUIRED",
                error: "Missing required fields for zeos_end_session.",
                missing_fields: missing,
                hint: "All four are required: `project`, `summary`, `nextActions`, and bridge content (`delta` is the catch-all).",
                expected_shape: {
                  project: "string (required)",
                  summary: "string (required)",
                  nextActions: "string (required)",
                  delta: "string (catch-all bridge content; required if no structured fields provided)",
                },
              }),
            }],
            isError: true,
          };
        }

        const app = findProject(project);
        if (!app) {
          return {
            content: [{
              type: "text",
              text: buildErrorEnvelope({
                error_code: "ZEOS_PROJECT_NOT_FOUND",
                error: `Project not found: ${project}`,
                hint: "Check the project registry at apps/REGISTRY.json or run zeos_fleet to list known projects.",
                offending_field: "project",
                offending_sample: project,
              }),
            }],
            isError: true,
          };
        }

        // Auto-resolve agent from session registry, fallback to explicit param or default
        const agent = (args?.agent as string) || _sessionAgents[app.app_id] || "claude";

        const journalDir = resolveJournalPath(app);
        const expanded = expandPath(journalDir);
        const timestamp = new Date().toISOString();
        const date = timestamp.split('T')[0];
        const redactedSummary = redactSensitiveText(summary);
        const redactedTitle = redactSensitiveText(title);
        const redactedFinalBridge = redactSensitiveText(finalBridge);
        const redactedNextActions = redactSensitiveText(nextActions);
        const redactedWhy = redactSensitiveText(why);
        const redactedHowToApply = redactSensitiveText(howToApply);
        const redactedRefsText = redactSensitiveText(refs.join('\n'));
        const redactedRefs = normalizeStringList(redactedRefsText.text);
        const redactedGitSnapshot = redactSensitiveText(getGitSnapshot(app));
        const redactions = mergeRedactions(
          redactedSummary,
          redactedTitle,
          redactedFinalBridge,
          redactedNextActions,
          redactedWhy,
          redactedHowToApply,
          redactedRefsText,
          redactedGitSnapshot
        );

        // Find THIS agent's journal via session registry (compound key), fallback to filesystem scan
        const sessionKey = `${app.app_id}::${agent}`;
        let targetJournal: string | null = _activeJournals[sessionKey] || null;
        if (!targetJournal || !fs.existsSync(path.join(expanded, targetJournal))) {
          // Fallback: find this agent's journal from today (backward compat)
          const journals = fs.readdirSync(expanded)
            .filter((f: string) => f.startsWith(date) && f.includes(`-${agent}.md`))
            .sort()
            .reverse();
          // If no agent-specific journal, fall back to newest today
          if (journals.length === 0) {
            const allJournals = fs.readdirSync(expanded)
              .filter((f: string) => f.startsWith(date) && f.endsWith('.md'))
              .sort()
              .reverse();
            targetJournal = allJournals[0] || null;
          } else {
            targetJournal = journals[0];
          }
        }

        const journalPath: string | null = targetJournal ? path.join(expanded, targetJournal) : null;

        if (journalPath) {
          // Mark journal as complete
          let content = fs.readFileSync(journalPath, 'utf-8');
          content = content.replace('status: active', 'status: complete');

          const endEntry = `
## Session End: ${timestamp}

### Summary
${redactedSummary.text}

### Final Bridge
${redactedFinalBridge.text}

### Next Actions
${redactedNextActions.text}

${tags.length > 0 ? `### Tags\n${formatListSection(tags)}\n` : ''}
${redactedGitSnapshot.text ? `${redactedGitSnapshot.text}\n` : ''}
${formatRedactionNotice(redactions)}

---
*Session complete*
`;

          fs.writeFileSync(journalPath, content + endEntry);
          verifyJournalWritten(journalPath);
        }

        // Clear session registries for this agent's session
        delete _activeJournals[sessionKey];
        delete _sessionAgents[app.app_id];

        // Update MEMORY.md with session summary and auto-curate.
        // Lockfile prevents lost updates when parallel agents /end simultaneously.
        // MEMORY.md lives at ~/.zeos/memory/<app_id>/MEMORY.md.
        const memoryPath = expandPath(resolveMemoryPath(app));
        const archivePath = path.join(path.dirname(memoryPath), "MEMORY_ARCHIVE.md");
        // Ensure the memory directory exists before writing
        fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
        const tokenLimit = getMemoryTokenLimit();
        let curationMessage = "";

        const lockAcquired = acquireMemoryLock(memoryPath);
        if (!lockAcquired) {
          // Journal is already saved — MEMORY.md update is best-effort
          curationMessage = "\nWarning: Could not acquire MEMORY.md lock (parallel write in progress). Journal saved, MEMORY.md update skipped.";
        }

        try {
          if (lockAcquired) {
            // Extract first line of summary as title (allow longer titles for better recall)
            const summaryTitle = redactedTitle.text.trim()
              ? redactedTitle.text.trim().substring(0, 150)
              : titleFromSummary(redactedSummary.text);
            const memoryEntryContent = formatMemoryEntryContent(
              redactedSummary.text,
              redactedFinalBridge.text,
              redactedNextActions.text,
              journalPath,
              redactions,
              redactedWhy.text,
              redactedHowToApply.text,
              redactedRefs
            );

            if (fs.existsSync(memoryPath)) {
              // Read MEMORY.md under lock (fresh read guarantees we see other agents' entries)
              const existing = fs.readFileSync(memoryPath, 'utf-8');

              // Load existing archive if present
              let archiveContent = "";
              if (fs.existsSync(archivePath)) {
                archiveContent = fs.readFileSync(archivePath, 'utf-8');
              }

              const parsed = parseMemoryMd(existing, archiveContent);
              ageMemoryEntries(parsed);

              // Add new entry with enough recency TTL to survive normal 10-20 session continuity.
              const newEntry: MemoryEntry = {
                date,
                title: summaryTitle,
                decay: MEMORY_ENTRY_DECAY_DEFAULT,
                importance,
                tags,
                refs: redactedRefs,
                promoted: false,
                content: memoryEntryContent,
                isArchived: false
              };
              parsed.entries.unshift(newEntry); // Add to beginning

              // Generate and update Continuity Digest
              const digest = generateContinuityDigest(
                journalDir,
                redactedSummary.text,
                redactedNextActions.text,
                redactedFinalBridge.text
              );
              parsed.continuityDigest = formatContinuityDigest(digest);

              // Auto-curate if over token limit
              const { curated, movedEntries } = curateMemory(parsed, tokenLimit);

              if (movedEntries.length > 0) {
                curationMessage = `\nAuto-curated: ${movedEntries.length} entries moved to MEMORY_ARCHIVE.md (token limit: ${tokenLimit})`;

                // Write/update archive file
                fs.writeFileSync(archivePath, formatMemoryMd(curated, 'archive'));
              }

              // Write updated MEMORY.md (active entries only + digest)
              fs.writeFileSync(memoryPath, formatMemoryMd(curated));
            } else {
              // Create new MEMORY.md with proper format
              const digest = generateContinuityDigest(
                journalDir,
                redactedSummary.text,
                redactedNextActions.text,
                redactedFinalBridge.text
              );
              const newMemory: ParsedMemory = {
                frontmatter: {
                  document: "MEMORY",
                  project: app.app_id,
                  purpose: "Rolling synopsis of session work - long-term memory tier",
                  token_estimate: 0,
                  entry_count: 1,
                  archive_count: 0
                },
                projectName: app.name,
                entries: [{
                  date,
                  title: summaryTitle,
                  decay: MEMORY_ENTRY_DECAY_DEFAULT,
                  importance,
                  tags,
                  refs: redactedRefs,
                  promoted: false,
                  content: memoryEntryContent,
                  isArchived: false
                }],
                archivedEntries: [],
                continuityDigest: formatContinuityDigest(digest)
              };
              fs.writeFileSync(memoryPath, formatMemoryMd(newMemory));
            }
          }
        } finally {
          if (lockAcquired) {
            releaseMemoryLock(memoryPath);
          }
        }

        // Check for promotion candidates: high-importance entries.
        let promotionHints = "";
        const existingContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : "";
        const existingParsed = parseMemoryMd(existingContent);
        const candidates = existingParsed.entries.filter(e =>
          e.importance >= MEMORY_PROMOTION_IMPORTANCE_THRESHOLD
        );

        if (candidates.length > 0) {
          promotionHints = "\n\nSOUL Promotion Candidates:\n";
          for (const c of candidates) {
            const tagSuffix = c.tags.length > 0 ? ` tags:${c.tags.join(",")}` : "";
            promotionHints += `   - "${c.title}" (importance:${c.importance}, decay:${c.decay}${tagSuffix})\n`;
          }
          promotionHints += "   Consider adding to SOUL.md if these are core project patterns.\n";
        }

        const handoff = `
═══════════════════════════════════════════════════════════════
SESSION COMPLETE
═══════════════════════════════════════════════════════════════

${journalPath ? `Journal: ${journalPath}\n` : ''}Summary saved to MEMORY.md${curationMessage}${promotionHints}

Next session:
  /zeos
  /project ${app.app_id}

Resume: ${redactedNextActions.text.split('\n')[0]}

═══════════════════════════════════════════════════════════════
`;

        return { content: [{ type: "text", text: handoff }] };
      }

      case "zeos_help": {
        const helpText = `
# zeos Shell Commands

## Core Commands

| Command | Purpose |
|---------|---------|
| \`/zeos\` | Boot zeos (lean mode default) |
| \`/project <id>\` | Load project with three-tier memory |
| \`/snap\` | Save progress to journal |
| \`/end\` | End session, update MEMORY.md |

## Discovery Commands

| Command | Purpose |
|---------|---------|
| \`/fleet\` | Portfolio overview from REGISTRY.json |
| \`/parallel <project>\` | Check for concurrent agents |
| \`/memory-curate <action> [args]\` | Curate MEMORY.md (stats, list, pin, unpin, delete, promote, merge, find) |
| \`/promote-soul <date> <section>\` | Promote MEMORY entry doctrine (Why + How to Apply) to SOUL.md; dry-run by default |
| \`/help\` | Show this help |

## Three-Tier Memory

1. **Long-Term (MEMORY.md)**: Rolling synopsis, key decisions
2. **Mid-Term**: Last 3 session summaries
3. **Short-Term**: Current session journal

## Boot Modes

- **LEAN** (default): ~6K tokens, fast boot
- **FULL** (explicit): ~35K tokens, set \`boot_mode: full\` in profile

---
*zeos Inject MCP v1.0.0*
`;
        return { content: [{ type: "text", text: helpText }] };
      }

      case "zeos_parallel": {
        const project = args?.project as string;
        if (!project) {
          return { content: [{ type: "text", text: "Error: project required" }], isError: true };
        }

        const app = findProject(project);
        if (!app) {
          return { content: [{ type: "text", text: `Error: Project not found: ${project}` }], isError: true };
        }

        const journalDir = resolveJournalPath(app);
        const instances = checkParallelInstances(journalDir);

        let output: string;
        if (instances.length === 0) {
          output = `✓ No active parallel instances on ${app.app_id}. Safe to proceed.`;
        } else {
          output = `⚠️ PARALLEL INSTANCES on ${app.app_id}: ${instances.join(', ')}\n\nCoordinate before making changes.`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "zeos_memory_curate": {
        const project = args?.project as string;
        const action = args?.action as string;
        const actionArgs = (args?.args as string) || "";

        if (!project || !action) {
          return { content: [{ type: "text", text: "Error: project and action required" }], isError: true };
        }

        const app = findProject(project);
        if (!app) {
          return { content: [{ type: "text", text: `Error: Project not found: ${project}` }], isError: true };
        }

        const memoryPath = expandPath(resolveMemoryPath(app));
        const archivePath = path.join(path.dirname(memoryPath), "MEMORY_ARCHIVE.md");

        if (!fs.existsSync(memoryPath)) {
          return { content: [{ type: "text", text: `Error: No MEMORY.md found for ${project}` }], isError: true };
        }

        const content = fs.readFileSync(memoryPath, 'utf-8');
        const archiveContent = fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf-8') : "";
        const parsed = parseMemoryMd(content, archiveContent);

        let result = "";

        switch (action.toLowerCase()) {
          case "stats": {
            const totalTokens = estimateTokens(content);
            const tokenLimit = getMemoryTokenLimit();
            const healthPercent = Math.round((totalTokens / tokenLimit) * 100);
            const healthStatus = healthPercent < 70 ? "🟢 Healthy" :
                                 healthPercent < 90 ? "🟡 Filling" : "🔴 Near limit";

            result = `
# MEMORY.md Stats: ${project}

| Metric | Value |
|--------|-------|
| Active Entries | ${parsed.entries.length} |
| Archived Entries | ${parsed.archivedEntries.length} |
| Token Estimate | ${totalTokens} |
| Token Limit | ${tokenLimit} |
| Usage | ${healthPercent}% |
| Health | ${healthStatus} |

## Active Entries by Retention

${parsed.entries.map(e => `- [decay:${e.decay}, importance:${e.importance}] ${e.date}: ${e.title}`).join('\n') || '*No entries*'}

## Archive Preview

${parsed.archivedEntries.slice(0, 5).map(e => `- ${e.date}: ${e.title}`).join('\n') || '*No archived entries*'}
${parsed.archivedEntries.length > 5 ? `\n... and ${parsed.archivedEntries.length - 5} more` : ''}
`;
            break;
          }

          case "list": {
            result = `# MEMORY.md Entries: ${project}\n\n## Active\n\n`;
            for (const e of parsed.entries) {
              result += `- **${e.date}**: ${e.title} [decay:${e.decay}, importance:${e.importance}]\n`;
            }
            result += `\n## Archived\n\n`;
            for (const e of parsed.archivedEntries) {
              result += `- **${e.date}**: ${e.title} [decay:${e.decay}, importance:${e.importance}]\n`;
            }
            break;
          }

          case "find": {
            const tags = actionArgs.split(",").map(s => s.trim()).filter(Boolean);
            if (tags.length === 0) {
              return { content: [{ type: "text", text: "Error: 'find' requires comma-separated tags in args (e.g., \"foo,bar\")" }], isError: true };
            }
            const matches = findMemoryByTags(content, archiveContent, tags);
            if (matches.length === 0) {
              result = `# MEMORY.md find: ${project}\n\nNo entries matched tags: ${tags.join(", ")} (AND semantics, searched active + archive).`;
            } else {
              result = `# MEMORY.md find: ${project}\n\nTags: ${tags.join(", ")} (AND semantics)\nFound ${matches.length} ${matches.length === 1 ? "entry" : "entries"}:\n\n`;
              for (const e of matches) {
                const where = e.isArchived ? "archived" : "active";
                const tagList = e.tags.length > 0 ? e.tags.join(",") : "(none)";
                result += `- [${where}] **${e.date}**: ${e.title} [decay:${e.decay}, importance:${e.importance}, tags:${tagList}]\n`;
              }
            }
            break;
          }

          case "pin": {
            const targetDate = actionArgs.trim();
            if (!targetDate) {
              return { content: [{ type: "text", text: "Error: pin requires a date (e.g., 2026-02-01)" }], isError: true };
            }
            const entry = parsed.entries.find(e => e.date === targetDate);
            if (!entry) {
              return { content: [{ type: "text", text: `Error: No active entry found for date ${targetDate}` }], isError: true };
            }
            entry.decay = Math.max(entry.decay, MEMORY_ENTRY_DECAY_DEFAULT);
            entry.importance = 5;
            entry.tags = [...new Set([...(entry.tags || []), "pinned"])];
            fs.writeFileSync(memoryPath, formatMemoryMd(parsed));
            result = `✓ Pinned entry ${targetDate} (importance set to 5)`;
            break;
          }

          case "unpin": {
            const targetDate = actionArgs.trim();
            if (!targetDate) {
              return { content: [{ type: "text", text: "Error: unpin requires a date (e.g., 2026-02-01)" }], isError: true };
            }
            const entry = parsed.entries.find(e => e.date === targetDate);
            if (!entry) {
              return { content: [{ type: "text", text: `Error: No active entry found for date ${targetDate}` }], isError: true };
            }
            entry.importance = MEMORY_ENTRY_IMPORTANCE_DEFAULT;
            entry.tags = (entry.tags || []).filter(t => t !== "pinned");
            fs.writeFileSync(memoryPath, formatMemoryMd(parsed));
            result = `✓ Unpinned entry ${targetDate} (importance reset to ${MEMORY_ENTRY_IMPORTANCE_DEFAULT})`;
            break;
          }

          case "delete": {
            const targetDate = actionArgs.trim();
            if (!targetDate) {
              return { content: [{ type: "text", text: "Error: delete requires a date (e.g., 2026-02-01)" }], isError: true };
            }
            const activeIndex = parsed.entries.findIndex(e => e.date === targetDate);
            const archiveIndex = parsed.archivedEntries.findIndex(e => e.date === targetDate);

            if (activeIndex === -1 && archiveIndex === -1) {
              return { content: [{ type: "text", text: `Error: No entry found for date ${targetDate}` }], isError: true };
            }

            if (activeIndex !== -1) {
              parsed.entries.splice(activeIndex, 1);
              fs.writeFileSync(memoryPath, formatMemoryMd(parsed));
              result = `✓ Deleted entry ${targetDate} from MEMORY.md`;
            } else {
              parsed.archivedEntries.splice(archiveIndex, 1);
              if (parsed.archivedEntries.length > 0) {
                fs.writeFileSync(archivePath, formatMemoryMd(parsed, 'archive'));
              } else if (fs.existsSync(archivePath)) {
                fs.unlinkSync(archivePath);
              }
              result = `✓ Deleted entry ${targetDate} from MEMORY_ARCHIVE.md`;
            }
            break;
          }

          case "promote": {
            const targetDate = actionArgs.trim();
            if (!targetDate) {
              return { content: [{ type: "text", text: "Error: promote requires a date (e.g., 2026-01-15)" }], isError: true };
            }
            const archiveIndex = parsed.archivedEntries.findIndex(e => e.date === targetDate);
            if (archiveIndex === -1) {
              return { content: [{ type: "text", text: `Error: No archived entry found for date ${targetDate}` }], isError: true };
            }
            const entry = parsed.archivedEntries.splice(archiveIndex, 1)[0];
            entry.isArchived = false;
            entry.decay = Math.max(entry.decay, MEMORY_ENTRY_DECAY_DEFAULT);
            entry.importance = Math.max(entry.importance, MEMORY_ENTRY_IMPORTANCE_DEFAULT);
            parsed.entries.push(entry);

            // Write both files
            fs.writeFileSync(memoryPath, formatMemoryMd(parsed));
            if (parsed.archivedEntries.length > 0) {
              fs.writeFileSync(archivePath, formatMemoryMd(parsed, 'archive'));
            } else if (fs.existsSync(archivePath)) {
              // Remove empty archive file
              fs.unlinkSync(archivePath);
            }
            result = `✓ Promoted entry ${targetDate} from MEMORY_ARCHIVE.md to MEMORY.md`;
            break;
          }

          case "merge": {
            const dates = actionArgs.trim().split(/\s+/);
            if (dates.length < 2) {
              return { content: [{ type: "text", text: "Error: merge requires two dates (e.g., 2026-02-01 2026-02-02)" }], isError: true };
            }
            const [date1, date2] = dates;
            const entry1 = parsed.entries.find(e => e.date === date1);
            const entry2 = parsed.entries.find(e => e.date === date2);

            if (!entry1 || !entry2) {
              return { content: [{ type: "text", text: `Error: Both dates must be active entries. Found: ${entry1 ? date1 : 'missing ' + date1}, ${entry2 ? date2 : 'missing ' + date2}` }], isError: true };
            }

            // Merge: combine titles/content, preserve strongest retention metadata, use earlier date.
            // Promotion marker survives if either source was promoted (audit-preserving union).
            const mergedEntry: MemoryEntry = {
              date: entry1.date < entry2.date ? entry1.date : entry2.date,
              title: `${entry1.title} + ${entry2.title}`,
              decay: Math.max(entry1.decay, entry2.decay),
              importance: Math.max(entry1.importance, entry2.importance),
              tags: [...new Set([...(entry1.tags || []), ...(entry2.tags || [])])],
              refs: [...new Set([...(entry1.refs || []), ...(entry2.refs || [])])],
              promoted: Boolean(entry1.promoted || entry2.promoted),
              content: `${entry1.content}\n\n---\n\n${entry2.content}`,
              isArchived: false
            };

            // Remove both original entries by reference (not date, to avoid same-date collisions)
            const idx1 = parsed.entries.indexOf(entry1);
            if (idx1 !== -1) parsed.entries.splice(idx1, 1);
            const idx2 = parsed.entries.indexOf(entry2);
            if (idx2 !== -1) parsed.entries.splice(idx2, 1);
            parsed.entries.unshift(mergedEntry);

            fs.writeFileSync(memoryPath, formatMemoryMd(parsed));
            result = `✓ Merged entries ${date1} and ${date2} into single entry`;
            break;
          }

          default:
            return { content: [{ type: "text", text: `Unknown action: ${action}. Valid: stats, list, pin, unpin, delete, promote, merge, find` }], isError: true };
        }

        return { content: [{ type: "text", text: result }] };
      }

      case "zeos_soul_promote": {
        const project = args?.project as string;
        const entry_date = args?.entry_date as string;
        const entry_title = (args?.entry_title as string) || undefined;
        const section = args?.section as string;
        const dry_run = args?.dry_run !== false; // default true

        if (!project || !entry_date || !section) {
          return { content: [{ type: "text", text: "Error: project, entry_date, and section are required" }], isError: true };
        }

        const app = findProject(project);
        if (!app) {
          return { content: [{ type: "text", text: `Error: Project not found: ${project}` }], isError: true };
        }

        const soulPath = expandPath(resolveSoulPath(app));
        const memoryPath = expandPath(resolveMemoryPath(app));

        const promoteResult = promoteMemoryEntryToSoul({
          soulPath,
          memoryPath,
          entryDate: entry_date,
          entryTitle: entry_title,
          section,
          dryRun: dry_run,
        });

        if (promoteResult.error) {
          return { content: [{ type: "text", text: `Error: ${promoteResult.error}` }], isError: true };
        }

        if (promoteResult.dryRun) {
          return {
            content: [{
              type: "text",
              text: `[DRY RUN] Project: ${project} | Section: ${section} | Entry: ${entry_date}${entry_title ? ` (${entry_title})` : ""}\n\n${promoteResult.preview}\n\nTo commit, call again with dry_run=false.`
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: `Promoted MEMORY entry ${entry_date} to SOUL.md section "${section}" for project ${project}. Source MEMORY entry marked [promoted:true].`
          }]
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error}` }], isError: true };
  }
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "zeos://boot/default",
      name: "zeos Boot Payload",
      mimeType: "text/markdown",
      description: "Compiled zeos boot payload (lean mode)"
    },
    {
      uri: "zeos://registry",
      name: "zeos Registry",
      mimeType: "application/json",
      description: "Project registry (REGISTRY.json)"
    }
  ]
}));

// Handle resource reads
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "zeos://boot/default") {
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: compileBootPayload(DEFAULT_PROFILE)
      }]
    };
  }

  if (uri === "zeos://registry") {
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: readFile(REGISTRY_PATH)
      }]
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("zeos Inject MCP server v1.0.0 running on stdio");
}

main().catch(console.error);
