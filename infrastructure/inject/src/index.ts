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
  ZEOS_APPS_ROOT,
  expandPath as resolverExpandPath,
  resolveJournalPath as resolverResolveJournalPath,
  resolveMemoryPath as resolverResolveMemoryPath,
  resolveSoulPath as resolverResolveSoulPath,
  resolveProjectClaudeMdPath as resolverResolveProjectClaudeMdPath,
  verifyJournalWritten,
} from "./path-resolver.js";

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const ZEOS_ROOT = "~/projects/zeos";
const REGISTRY_PATH = `${ZEOS_ROOT}/apps/REGISTRY.json`;
const DEFAULT_PROFILE = "operator";

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
// MEMORY CURATION UTILITIES
// ═══════════════════════════════════════════════════════════════

interface MemoryEntry {
  date: string;
  title: string;
  decay: number;
  content: string;
  isArchived: boolean;
}

interface ParsedMemory {
  frontmatter: Record<string, any>;
  projectName: string;
  entries: MemoryEntry[];
  archivedEntries: MemoryEntry[]; // Keep this for zeos_memory_curate to handle both
  continuityDigest?: string;       // Raw digest section if present
}

function estimateTokens(text: string): number {
  // Markdown/YAML-heavy content averages ~1.8 tokens per word
  // (punctuation, brackets, colons, dashes all tokenize separately)
  const words = text.split(/\s+/).length;
  return Math.ceil(words * 1.8);
}

/**
 * Extract summary section from a journal using multi-pattern matching.
 * Handles all known journal formats across the portfolio:
 *   - ### Summary (current /end format, h3)
 *   - ## Session Summary (legacy, h2)
 *   - ## Executive Summary (legacy example-project/zeos-dev, h2)
 *   - ## Summary (mid-era, h2)
 *   - ## Mission Summary (example-game, h2)
 *   - ## {Qualifier} Summary (various legacy variants)
 *
 * Returns the summary body text, or null if no summary section found.
 */
function extractJournalSummary(content: string): string | null {
  // Try patterns in priority order (most specific/current first)
  const patterns = [
    /### Summary\n([\s\S]*?)(?=\n###|\n## |$)/,         // Current /end format (h3)
    /## Session Summary\n([\s\S]*?)(?=\n## |\n# |$)/,   // Legacy standard (h2)
    /## Executive Summary\n([\s\S]*?)(?=\n## |\n# |$)/, // Legacy example-project (h2)
    /## Mission Summary\n([\s\S]*?)(?=\n## |\n# |$)/,   // example-game (h2)
    /## Summary\n([\s\S]*?)(?=\n## |\n# |$)/,           // Mid-era generic (h2)
    /## \w[\w\s]* Summary\n([\s\S]*?)(?=\n## |\n# |$)/, // Any "## {Word} Summary" variant
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }

  return null;
}

function parseMemoryMd(content: string, archiveContent: string = ""): ParsedMemory {
  const result: ParsedMemory = {
    frontmatter: {},
    projectName: "",
    entries: [],
    archivedEntries: []
  };

  // Parse frontmatter from active memory
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fmLines = fmMatch[1].split('\n');
    for (const line of fmLines) {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length) {
        const value = valueParts.join(':').trim().replace(/^["']|["']$/g, '');
        result.frontmatter[key.trim()] = isNaN(Number(value)) ? value : Number(value);
      }
    }
  }

  // Extract project name from header
  const nameMatch = content.match(/# Project Memory: (.+)/);
  if (nameMatch) {
    result.projectName = nameMatch[1];
  }

  // Extract continuity digest if present
  const digestMatch = content.match(/## Continuity Digest\n\n([\s\S]*?)(?=\n## \d{4}|$)/);
  if (digestMatch) {
    result.continuityDigest = digestMatch[0];
  }

  // Parse active entries (skip the digest section)
  const entryRegex = /## (\d{4}-\d{2}-\d{2}): (.+?) \[decay:(\d+)\]\n\n([\s\S]*?)(?=\n---|\n## \d{4}|## Continuity|$)/g;

  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    result.entries.push({
      date: match[1],
      title: match[2],
      decay: parseInt(match[3], 10),
      content: match[4].trim(),
      isArchived: false
    });
  }

  // Parse archived entries from archiveContent
  if (archiveContent) {
    entryRegex.lastIndex = 0;
    while ((match = entryRegex.exec(archiveContent)) !== null) {
      result.archivedEntries.push({
        date: match[1],
        title: match[2],
        decay: parseInt(match[3], 10),
        content: match[4].trim(),
        isArchived: true
      });
    }
  }

  return result;
}

function formatMemoryMd(parsed: ParsedMemory, type: 'active' | 'archive' = 'active'): string {
  if (type === 'archive') {
    let output = `# Project Memory Archive: ${parsed.projectName}\n\n`;
    output += `*Cold storage for project memory entries moved from MEMORY.md*\n\n---\n\n`;
    for (const entry of parsed.archivedEntries) {
      output += `## ${entry.date}: ${entry.title} [decay:${entry.decay}]\n\n`;
      output += `${entry.content}\n\n`;
      output += '---\n\n';
    }
    return output;
  }

  // Update counts
  parsed.frontmatter.entry_count = parsed.entries.length;
  parsed.frontmatter.archive_count = parsed.archivedEntries.length;

  // Calculate token estimate for ALL content (entries + digest + header)
  let allContent = `# Project Memory: ${parsed.projectName}\n\n`;
  if (parsed.continuityDigest) {
    allContent += parsed.continuityDigest;
  }
  for (const entry of parsed.entries) {
    allContent += `## ${entry.date}: ${entry.title} [decay:${entry.decay}]\n\n${entry.content}\n\n---\n\n`;
  }
  parsed.frontmatter.token_estimate = estimateTokens(allContent);

  // Build frontmatter
  let output = '---\n';
  for (const [key, value] of Object.entries(parsed.frontmatter)) {
    if (typeof value === 'string') {
      output += `${key}: "${value}"\n`;
    } else {
      output += `${key}: ${value}\n`;
    }
  }
  output += '---\n\n';

  // Add header
  output += `# Project Memory: ${parsed.projectName}\n\n`;

  // Add continuity digest if present (goes first after header)
  if (parsed.continuityDigest) {
    output += parsed.continuityDigest.trimEnd() + '\n\n';
  }

  // Add active entries
  for (const entry of parsed.entries) {
    output += `## ${entry.date}: ${entry.title} [decay:${entry.decay}]\n\n`;
    output += `${entry.content}\n\n`;
    output += '---\n\n';
  }

  return output;
}

function getMemoryTokenLimit(profileName: string = DEFAULT_PROFILE): number {
  const profilePath = `${ZEOS_ROOT}/profiles/${profileName}/PROFILE.md`;
  const content = readFile(profilePath);
  const match = content.match(/memory_token_limit:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 10000; // Default 10,000
}

interface ContinuityDigest {
  lastSessions: string[];    // Last 3 session summaries
  openThreads: string[];     // Unresolved items
  decisions: string[];       // Key decisions/constraints
  nextActions: string[];     // Ordered next steps
}

function generateContinuityDigest(
  journalDir: string,
  currentSummary: string,
  nextActions: string
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

  // Extract open threads from nextActions (lines starting with - [ ] or TODO)
  const actionLines = nextActions.split('\n');
  for (const line of actionLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- [ ]') || trimmed.toLowerCase().includes('todo')) {
      digest.openThreads.push(trimmed.replace(/^-\s*\[\s*\]\s*/, '').trim());
    } else if (trimmed.startsWith('-') || trimmed.match(/^\d+\./)) {
      digest.nextActions.push(trimmed.replace(/^[-\d.]+\s*/, '').trim());
    }
  }

  // If no structured actions, use the whole nextActions as a single item
  if (digest.nextActions.length === 0 && nextActions.trim()) {
    digest.nextActions.push(nextActions.trim().split('\n')[0]);
  }

  // Extract decisions from summary (lines with decision-indicating keywords)
  const summaryLines = currentSummary.split('\n');
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

function curateMemory(parsed: ParsedMemory, tokenLimit: number): { curated: ParsedMemory; movedEntries: MemoryEntry[] } {
  const movedEntries: MemoryEntry[] = [];

  // Decrement all active entry decay scores by 1 (minimum 0)
  for (const entry of parsed.entries) {
    entry.decay = Math.max(0, entry.decay - 1);
  }

  // Check if we're over the limit
  let currentTokens = parsed.frontmatter.token_estimate || estimateTokens(formatMemoryMd(parsed));

  if (currentTokens <= tokenLimit) {
    return { curated: parsed, movedEntries: [] };
  }

  // Sort entries by decay (ascending) - lowest decay first
  const sortedEntries = [...parsed.entries].sort((a, b) => a.decay - b.decay);

  // Move entries with lowest decay to archive until under limit
  while (currentTokens > tokenLimit && sortedEntries.length > 0) {
    const entryToArchive = sortedEntries[0];

    // Don't archive pinned entries (decay >= 6)
    if (entryToArchive.decay >= 6) {
      break; // All remaining entries are pinned
    }

    // Move to movedEntries list (use reference equality to avoid same-date collisions)
    sortedEntries.shift();
    const archiveIdx = parsed.entries.indexOf(entryToArchive);
    if (archiveIdx !== -1) {
      parsed.entries.splice(archiveIdx, 1);
    }
    entryToArchive.isArchived = true;
    movedEntries.push(entryToArchive);
    parsed.archivedEntries.unshift(entryToArchive); // Also update internal list for stats

    // Recalculate tokens
    currentTokens = estimateTokens(formatMemoryMd(parsed));
  }

  return { curated: parsed, movedEntries };
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY-BASED PROJECT LOOKUP
// ═══════════════════════════════════════════════════════════════

interface AppEntry {
  app_id: string;
  name: string;
  type: string;
  status: string;
  repo?: { url: string; branch: string };
  local_path: string;
  soul_file: string;
  journal_location: string;
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

function getLatestJournal(journalDir: string): string | null {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) return null;

  const files = fs.readdirSync(expanded)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  // Find the most recent journal with substantive content (skip empty stubs)
  for (const file of files) {
    const filePath = path.join(expanded, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    // A stub is ~200 chars (frontmatter + header). Anything >300 has real content.
    const withoutFrontmatter = content.replace(/^---[\s\S]*?---\s*/, '');
    if (withoutFrontmatter.trim().length > 100) {
      return content;
    }
  }

  // All journals are stubs — return the newest one
  return fs.readFileSync(path.join(expanded, files[0]), 'utf-8');
}

function createJournalStub(journalDir: string, agentName: string): string {
  const expanded = expandPath(journalDir);

  if (!fs.existsSync(expanded)) {
    fs.mkdirSync(expanded, { recursive: true });
  }

  const date = new Date().toISOString().split('T')[0];
  const created = new Date().toISOString();

  // Atomic stub creation — O_CREAT|O_EXCL prevents sequence collisions
  // when multiple agents load the same project simultaneously.
  for (let seq = 1; seq <= 999; seq++) {
    const sequence = String(seq).padStart(3, '0');
    const filename = `${date}-${sequence}-${agentName}.md`;
    const stubPath = path.join(expanded, filename);

    const stub = `---
date: "${date}"
sequence: ${seq}
instance: "${agentName}"
status: active
created: "${created}"
---

# Session Journal: ${date}-${sequence}

*Session started via zeos Inject MCP*

---

`;

    try {
      fs.writeFileSync(stubPath, stub, { flag: 'wx' });  // Atomic create
      return filename;
    } catch (e: any) {
      if (e.code === 'EEXIST') continue;  // Sequence taken, try next
      throw e;
    }
  }

  throw new Error(`Failed to create journal stub: all 999 sequences exhausted for ${date}`);
}

function checkParallelInstances(journalDir: string): string[] {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) return [];

  const date = new Date().toISOString().split('T')[0];
  const todayJournals = fs.readdirSync(expanded)
    .filter(f => f.startsWith(date) && f.endsWith('.md'));

  const activeInstances: string[] = [];
  for (const journal of todayJournals) {
    const content = fs.readFileSync(path.join(expanded, journal), 'utf-8');
    if (content.includes('status: active')) {
      const match = journal.match(/\d{4}-\d{2}-\d{2}-\d{3}-(.+)\.md/);
      if (match) activeInstances.push(match[1]);
    }
  }

  return activeInstances;
}

// ═══════════════════════════════════════════════════════════════
// BOOT PAYLOAD COMPILATION
// ═══════════════════════════════════════════════════════════════

function compileBootPayload(profile: string = DEFAULT_PROFILE): string {
  const profilePath = `${ZEOS_ROOT}/profiles/${profile}/PROFILE.md`;

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
    soul = readFile(`${ZEOS_ROOT}/kernel/SOUL.md`);
    bootProtocol = readFile(`${ZEOS_ROOT}/kernel/BOOT_PROTOCOL.md`);
    shellProtocol = readFile(`${ZEOS_ROOT}/modules/constraints/SHELL_PROTOCOL.md`);
  } else {
    // LEAN BOOT - default
    soul = readFile(`${ZEOS_ROOT}/kernel/lean/SOUL_CORE.md`);
    bootProtocol = readFile(`${ZEOS_ROOT}/kernel/lean/BOOT_PROTOCOL_LEAN.md`);
    shellProtocol = readFile(`${ZEOS_ROOT}/kernel/lean/SHELL_PROTOCOL_LEAN.md`);
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
  // - SOUL.md (zeos-side) — identity, mission, constraints (WHO)
  // - Project CLAUDE.md (project repo, optional) — operations doctrine (HOW)
  const soul = readFile(soulPath);
  const expandedClaudeMd = expandPath(claudeMdPath);
  const projectClaudeMd = fs.existsSync(expandedClaudeMd)
    ? fs.readFileSync(expandedClaudeMd, "utf-8")
    : "";

  // Load three-tier memory — MEMORY.md lives at ~/projects/zeos/memory/<app_id>/MEMORY.md
  const memoryPath = resolveMemoryPath(app);
  const memory = loadMemory(journalDir, memoryPath);

  // Get latest full journal for current session context (BEFORE stub creation)
  const latestJournal = getLatestJournal(journalDir);

  // NOW create journal stub (after reading previous state)
  const journalStub = createJournalStub(journalDir, agentName);

  // Register this journal for the session — compound key ensures /snap and /end
  // target THIS agent's journal even when multiple agents work on same project.
  const sessionKey = `${app.app_id}::${agentName}`;
  _activeJournals[sessionKey] = journalStub;

  // Also register agent name for this project — enables /snap and /end to
  // auto-resolve agent without requiring explicit param every call.
  _sessionAgents[app.app_id] = agentName;

  // Build memory section
  let memorySection = "";

  if (memory.tier1_synopsis) {
    memorySection += `
# Long-Term Memory (MEMORY.md)

${memory.tier1_synopsis}

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

  // Check for active blueprint in MASTER_ROADMAP
  let blueprintSection = "";
  const roadmapPath = `${ZEOS_APPS_ROOT}/${app.local_path}docs/MASTER_ROADMAP.md`;
  if (fileExists(roadmapPath)) {
    const roadmap = readFile(roadmapPath);
    const bpMatch = roadmap.match(/active_blueprint:\s*"?([^"\n]+)"?/);
    if (bpMatch && bpMatch[1] !== "null") {
      const bpPath = `${ZEOS_APPS_ROOT}/${app.local_path}blueprints/${bpMatch[1]}`;
      if (fileExists(bpPath)) {
        blueprintSection = `\n---\n\n# Active Blueprint: ${bpMatch[1]}\n\n${readFile(bpPath)}`;
      }
    }
  }

  // Get git status
  let gitStatus = "";
  const repoPath = app.repo?.url ? `~/projects/${app.app_id}` : `${ZEOS_APPS_ROOT}/${app.local_path}`;
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

${parallelWarning}# Project SOUL

${soul || `_(no SOUL.md found at ${soulPath} — scaffold with \`/newproject\` or write one manually)_`}
${projectClaudeMd ? `
---

# Project CLAUDE.md (operations doctrine)

${projectClaudeMd}
` : ""}
${gitStatus}
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
            description: "Bridge content: state of the world, open threads, context that would be lost"
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
        required: ["project", "delta"]
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
          delta: {
            type: "string",
            description: "Final bridge: state, threads, context"
          },
          nextActions: {
            type: "string",
            description: "Handoff for next session"
          },
          agent: {
            type: "string",
            description: "Agent identifier for journal targeting (default: claude)"
          }
        },
        required: ["project", "summary", "delta", "nextActions"]
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
      description: "Manually curate project MEMORY.md. Actions: stats, merge, delete, promote, pin, unpin, list.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project ID"
          },
          action: {
            type: "string",
            description: "Action: stats, merge, delete, promote, pin, unpin, list"
          },
          args: {
            type: "string",
            description: "Action arguments (e.g., dates for merge)"
          }
        },
        required: ["project", "action"]
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
        const project = args?.project as string;
        const delta = args?.delta as string;
        const note = (args?.note as string) || "";

        if (!project || !delta) {
          return { content: [{ type: "text", text: "Error: project and delta required" }], isError: true };
        }

        const app = findProject(project);
        if (!app) {
          return { content: [{ type: "text", text: `Error: Project not found: ${project}` }], isError: true };
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
          return { content: [{ type: "text", text: "Error: No active journal found. Load project first." }], isError: true };
        }

        const journalPath = path.join(expanded, targetJournal);

        const snapEntry = `
## Checkpoint: ${timestamp.split('T')[1].substring(0,8)}

${note ? `**Note:** ${note}\n\n` : ''}### Bridge
${delta}

---
`;

        fs.appendFileSync(journalPath, snapEntry);
        verifyJournalWritten(journalPath);

        return { content: [{ type: "text", text: `✓ Checkpoint saved to ${journalPath}` }] };
      }

      case "zeos_end_session": {
        const project = args?.project as string;
        const summary = args?.summary as string;
        const delta = args?.delta as string;
        const nextActions = args?.nextActions as string;

        if (!project || !summary || !delta || !nextActions) {
          return { content: [{ type: "text", text: "Error: project, summary, delta, nextActions required" }], isError: true };
        }

        const app = findProject(project);
        if (!app) {
          return { content: [{ type: "text", text: `Error: Project not found: ${project}` }], isError: true };
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

        const journalPath: string | null = targetJournal ? path.join(expanded, targetJournal) : null;

        if (journalPath) {
          // Mark journal as complete
          let content = fs.readFileSync(journalPath, 'utf-8');
          content = content.replace('status: active', 'status: complete');

          const endEntry = `
## Session End: ${timestamp.split('T')[1].substring(0,8)}

### Summary
${summary}

### Final Bridge
${delta}

### Next Actions
${nextActions}

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
        // MEMORY.md lives at ~/projects/zeos/memory/<app_id>/MEMORY.md.
        const memoryPath = expandPath(resolveMemoryPath(app));
        const archivePath = path.join(path.dirname(memoryPath), "MEMORY_ARCHIVE.md");
        // Ensure the memory directory exists before writing
        fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
        const tokenLimit = getMemoryTokenLimit();
        let curationMessage = "";

        const lockAcquired = acquireMemoryLock(memoryPath);
        if (!lockAcquired) {
          // Journal is already saved — MEMORY.md update is best-effort
          curationMessage = "\n⚠️ Could not acquire MEMORY.md lock (parallel write in progress). Journal saved, MEMORY.md update skipped.";
        }

        try {
          if (lockAcquired) {
            // Extract first line of summary as title (allow longer titles for better recall)
            const summaryTitle = summary.split('\n')[0].substring(0, 150);

            if (fs.existsSync(memoryPath)) {
              // Read MEMORY.md under lock (fresh read guarantees we see other agents' entries)
              const existing = fs.readFileSync(memoryPath, 'utf-8');

              // Load existing archive if present
              let archiveContent = "";
              if (fs.existsSync(archivePath)) {
                archiveContent = fs.readFileSync(archivePath, 'utf-8');
              }

              const parsed = parseMemoryMd(existing, archiveContent);

              // Add new entry with decay:3 (survives 3 sessions before becoming archival candidate)
              const newEntry: MemoryEntry = {
                date,
                title: summaryTitle,
                decay: 3,
                content: summary,
                isArchived: false
              };
              parsed.entries.unshift(newEntry); // Add to beginning

              // Generate and update Continuity Digest
              const digest = generateContinuityDigest(journalDir, summary, nextActions);
              parsed.continuityDigest = formatContinuityDigest(digest);

              // Auto-curate if over token limit
              const { curated, movedEntries } = curateMemory(parsed, tokenLimit);

              if (movedEntries.length > 0) {
                curationMessage = `\n📦 Auto-curated: ${movedEntries.length} entries moved to MEMORY_ARCHIVE.md (token limit: ${tokenLimit})`;

                // Write/update archive file
                fs.writeFileSync(archivePath, formatMemoryMd(curated, 'archive'));
              }

              // Write updated MEMORY.md (active entries only + digest)
              fs.writeFileSync(memoryPath, formatMemoryMd(curated));
            } else {
              // Create new MEMORY.md with proper format
              const digest = generateContinuityDigest(journalDir, summary, nextActions);
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
                  decay: 3,
                  content: summary,
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

        // Check for promotion candidates (decay >= 4)
        let promotionHints = "";
        const existingContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : "";
        const existingParsed = parseMemoryMd(existingContent);
        const candidates = existingParsed.entries.filter(e => e.decay >= 4);

        if (candidates.length > 0) {
          promotionHints = "\n\n📌 SOUL Promotion Candidates:\n";
          for (const c of candidates) {
            promotionHints += `   - "${c.title}" (decay:${c.decay})\n`;
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

Resume: ${nextActions.split('\n')[0]}

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
| \`/memory-curate <action>\` | Curate MEMORY.md (stats, pin, merge, delete) |
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

## Active Entries by Decay

${parsed.entries.map(e => `- [decay:${e.decay}] ${e.date}: ${e.title}`).join('\n') || '*No entries*'}

## Archive Preview

${parsed.archivedEntries.slice(0, 5).map(e => `- ${e.date}: ${e.title}`).join('\n') || '*No archived entries*'}
${parsed.archivedEntries.length > 5 ? `\n... and ${parsed.archivedEntries.length - 5} more` : ''}
`;
            break;
          }

          case "list": {
            result = `# MEMORY.md Entries: ${project}\n\n## Active\n\n`;
            for (const e of parsed.entries) {
              result += `- **${e.date}**: ${e.title} [decay:${e.decay}]\n`;
            }
            result += `\n## Archived\n\n`;
            for (const e of parsed.archivedEntries) {
              result += `- **${e.date}**: ${e.title} [decay:${e.decay}]\n`;
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
            entry.decay = 6;
            fs.writeFileSync(memoryPath, formatMemoryMd(parsed));
            result = `✓ Pinned entry ${targetDate} (decay set to 6, will never auto-archive)`;
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
            entry.decay = 1;
            fs.writeFileSync(memoryPath, formatMemoryMd(parsed));
            result = `✓ Unpinned entry ${targetDate} (decay reset to 1)`;
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
            entry.decay = 2; // Give it a boost since operator promoted it
            parsed.entries.push(entry);

            // Write both files
            fs.writeFileSync(memoryPath, formatMemoryMd(parsed));
            if (parsed.archivedEntries.length > 0) {
              fs.writeFileSync(archivePath, formatMemoryMd(parsed, 'archive'));
            } else if (fs.existsSync(archivePath)) {
              // Remove empty archive file
              fs.unlinkSync(archivePath);
            }
            result = `✓ Promoted entry ${targetDate} from MEMORY_ARCHIVE.md to MEMORY.md (decay:2)`;
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

            // Merge: combine titles, combine content, use higher decay, use earlier date
            const mergedEntry: MemoryEntry = {
              date: entry1.date < entry2.date ? entry1.date : entry2.date,
              title: `${entry1.title} + ${entry2.title}`,
              decay: Math.max(entry1.decay, entry2.decay),
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
            return { content: [{ type: "text", text: `Unknown action: ${action}. Valid: stats, list, pin, unpin, delete, promote, merge` }], isError: true };
        }

        return { content: [{ type: "text", text: result }] };
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
