import * as fs from "node:fs";
import * as path from "node:path";
import { expandPath } from "../path-resolver.js";
import { extractListItems, filterPlaceholders } from "./digest.js";
import { estimateTokens } from "./memory.js";
import { appendFileSyncDurable } from "./atomic-write.js";

export const JOURNAL_SCHEMA_VERSION = "2.0.0";
// Single source of truth for "is this journal body real work, not a stub".
// Replaces the old module-private STUB_BODY_THRESHOLD and the inline `< 50`
// check that loadMemory used, so latest-selection and tier-2 agree.
export const SUBSTANTIVE_BODY_THRESHOLD = 100;

// -- frontmatter / body helpers ----------------------------------------------

function getFrontmatterStatus(content: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const match = fm[1].match(/^status:\s*(\S+)/m);
  return match ? match[1].trim() : "";
}

// Read a single frontmatter scalar (quoted or bare). Returns null if absent.
function getFrontmatterField(content: string, field: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const re = new RegExp(`^${field}:\\s*(?:"([^"]*)"|(\\S+))`, "m");
  const m = fm[1].match(re);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\s*/, "");
}

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

// Remove the inherited carry-forward block (heading up to the next H2, an HR,
// or end of text) so an unworked stub seeded with a digest is not mistaken for
// real session work.
function stripCarryForwardSection(body: string): string {
  return body.replace(
    /## Carry-Forward from Previous Session[\s\S]*?(?=\n## |\n---\n|$)/,
    ""
  );
}

// -- completion / substance signals ------------------------------------------

// Completion is derived from the appended `## Session End` block (new writes),
// fence-stripped and start-of-line anchored so a quoted heading inside a code
// block is not a false positive. Not timestamp-coupled, so it matches both the
// ISO runtime output and legacy/test fixtures like `## Session End: 15:00:00`.
export function hasSessionEndBlock(content: string): boolean {
  const body = stripFencedCodeBlocks(stripFrontmatter(content));
  return /^## Session End:/m.test(body);
}

// A session is complete if it has a Session End block OR a legacy
// `status: complete` frontmatter. New writes append the block and never flip
// status; the status branch is read-only back-compat for pre-block journals.
export function isJournalComplete(content: string): boolean {
  return hasSessionEndBlock(content) || getFrontmatterStatus(content) === "complete";
}

// An "unworked" stub carries no real session work: no checkpoint/end block, and
// no substantive body once the inherited carry-forward block is removed. This
// distinguishes a freshly-seeded stub (which may carry a >100-char carry-forward
// digest) from a journal that actually contains work. Substantive = !unworked.
export function isUnworkedStub(content: string): boolean {
  const body = stripFrontmatter(content);
  if (/^## (Checkpoint|Session End):/m.test(body)) return false;
  const withoutCarryForward = stripCarryForwardSection(body).trim();
  return withoutCarryForward.length <= SUBSTANTIVE_BODY_THRESHOLD;
}

export function extractJournalSummary(content: string): string | null {
  const patterns = [
    /### Summary\n([\s\S]*?)(?=\n###|\n## |$)/,
    /## Session Summary\n([\s\S]*?)(?=\n## |\n# |$)/,
    /## Executive Summary\n([\s\S]*?)(?=\n## |\n# |$)/,
    /## Mission Summary\n([\s\S]*?)(?=\n## |\n# |$)/,
    /## Summary\n([\s\S]*?)(?=\n## |\n# |$)/,
    /## \w[\w\s]* Summary\n([\s\S]*?)(?=\n## |\n# |$)/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }

  return null;
}

// -- journal metadata --------------------------------------------------------

export interface JournalMeta {
  file: string;
  sessionId: string;
  content: string;
  bodyLength: number;          // raw body length (informational)
  isSubstantive: boolean;      // = !isUnworkedStub(content): real work present
  isComplete: boolean;         // Session End block OR legacy status:complete
  previousSession: string | null;
}

export function readJournalMeta(journalDir: string, file: string): JournalMeta {
  const expanded = expandPath(journalDir);
  const content = fs.readFileSync(path.join(expanded, file), "utf-8");
  const sessionId =
    getFrontmatterField(content, "session_id") ??
    file.match(/^(\d{4}-\d{2}-\d{2}-\d{3})/)?.[1] ??
    file.replace(/\.md$/, "");
  const prevRaw = getFrontmatterField(content, "previous_session");
  const previousSession = prevRaw === null || prevRaw === "null" ? null : prevRaw;
  return {
    file,
    sessionId,
    content,
    bodyLength: stripFrontmatter(content).trim().length,
    isSubstantive: !isUnworkedStub(content),
    isComplete: isJournalComplete(content),
    previousSession,
  };
}

// Newest-first by filename.
export function listJournalMetas(journalDir: string): JournalMeta[] {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) return [];
  return fs
    .readdirSync(expanded)
    .filter(f => f.endsWith(".md"))
    .sort()
    .reverse()
    .map(f => readJournalMeta(journalDir, f));
}

// Latest = newest SUBSTANTIVE journal (skips unworked stubs), regardless of
// completion, else newest file (all-stub fallback). A newer interrupted journal
// with real work is the latest and must NOT be shadowed by an older completed
// one; completion is consumed by the continuation predicate, not by selection.
// Defines "latest" for both verbatim render and previous_session seeding.
export function getLatestJournalMeta(journalDir: string): JournalMeta | null {
  const metas = listJournalMetas(journalDir);
  if (metas.length === 0) return null;
  return metas.find(m => m.isSubstantive) ?? metas[0];
}

// Thin wrapper: existing callers/tests that want the raw content of the latest
// journal keep working; selection logic lives in getLatestJournalMeta (DRY).
export function getLatestJournal(journalDir: string): string | null {
  return getLatestJournalMeta(journalDir)?.content ?? null;
}

// -- stub creation + reuse ---------------------------------------------------

export function createJournalStub(
  journalDir: string,
  agentName: string,
  app: { app_id?: string } | null = null,
  carryForward: string = "",
  previousSession: string | null = null
): string {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) {
    fs.mkdirSync(expanded, { recursive: true });
  }

  const date = new Date().toISOString().split("T")[0];
  const created = new Date().toISOString();
  const previousSessionValue = previousSession === null ? "null" : `"${previousSession}"`;

  for (let seq = 1; seq <= 999; seq++) {
    const sequence = String(seq).padStart(3, "0");
    const filename = `${date}-${sequence}-${agentName}.md`;
    const stubPath = path.join(expanded, filename);
    const sessionId = `${date}-${sequence}`;

    let stub = `---
schema_version: "${JOURNAL_SCHEMA_VERSION}"
session_id: "${sessionId}"
project: "${app?.app_id || ""}"
date: "${date}"
sequence: ${seq}
agent: "${agentName}"
instance: "${agentName}"
status: active
created: "${created}"
previous_session: ${previousSessionValue}
---

# Session Journal: ${sessionId}

*Session started via zeos Inject MCP*

---

`;

    if (carryForward && carryForward.trim()) {
      stub += `${carryForward.trim()}\n\n---\n\n`;
    }

    try {
      fs.writeFileSync(stubPath, stub, { flag: "wx" });
      return filename;
    } catch (e: any) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
  }

  throw new Error(`Failed to create journal stub: all 999 sequences exhausted for ${date}`);
}

// Reuse this agent's same-day unworked stub ONLY when its recorded
// previous_session already equals the current prior (both-null = equal). A
// missing field (pre-PR1 stub) or a mismatch (a new substantive journal appeared
// since the stub was created) returns null so the caller mints a fresh,
// correctly-seeded stub; we never rewrite an existing stub's frontmatter.
export function findReusableEmptyStub(
  journalDir: string,
  agentName: string,
  date: string,
  expectedPreviousSession: string | null
): string | null {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) return null;
  const re = new RegExp(`^${date}-\\d{3}-${agentName}\\.md$`);
  const candidates = fs
    .readdirSync(expanded)
    .filter(f => re.test(f))
    .sort()
    .reverse(); // highest sequence first
  for (const file of candidates) {
    const content = fs.readFileSync(path.join(expanded, file), "utf-8");
    if (!isUnworkedStub(content)) continue;
    const prevRaw = getFrontmatterField(content, "previous_session");
    const prev = prevRaw === null || prevRaw === "null" ? null : prevRaw;
    if (prev === expectedPreviousSession) return file;
  }
  return null;
}

// -- parallel-instance detection ---------------------------------------------

// Active = today's journal that is not complete. When currentAgent is provided,
// that agent's own unworked stubs are excluded (reusable self-state, not a
// concurrent conflict); other agents and the current agent's substantive
// interrupted journals are still reported.
export function checkParallelInstances(journalDir: string, currentAgent?: string): string[] {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) return [];

  const date = new Date().toISOString().split("T")[0];
  const todayJournals = fs.readdirSync(expanded).filter(f => f.startsWith(date) && f.endsWith(".md"));

  const activeInstances: string[] = [];
  for (const journal of todayJournals) {
    const content = fs.readFileSync(path.join(expanded, journal), "utf-8");
    if (isJournalComplete(content)) continue;
    const match = journal.match(/\d{4}-\d{2}-\d{2}-\d{3}-(.+)\.md/);
    if (!match) continue;
    const agent = match[1];
    if (currentAgent && agent === currentAgent && isUnworkedStub(content)) continue;
    activeInstances.push(agent);
  }

  return activeInstances;
}

// -- /end append-only --------------------------------------------------------

// Append-only finalization: the `## Session End` block IS the completion marker.
// Never rewrites the file or flips frontmatter status. Durable (append + fsync)
// for torn-append protection, with a pre-append redaction gate so a
// secret-shaped block never reaches the append-only file (where a post-write
// throw would be too late).
export function appendSessionEnd(journalPath: string, endEntry: string): void {
  appendFileSyncDurable(journalPath, endEntry);
}

// -- continuation load chain -------------------------------------------------

// Next Actions from the Session End region only (NOT the inherited carry-forward
// block at the top), placeholder-filtered. Only meaningful once a Session End
// block exists; legacy complete journals without one yield false.
export function hasOpenNextActions(content: string): boolean {
  const body = stripFrontmatter(content);
  const endIdx = body.search(/^## Session End:/m);
  if (endIdx === -1) return false;
  const endRegion = body.slice(endIdx);
  const m = endRegion.match(/### Next Actions\n([\s\S]*?)(?=\n### |\n---|\n## |$)/);
  if (!m) return false;
  return filterPlaceholders(extractListItems(m[1])).length > 0;
}

// Continuation predicate: load a prior journal when the latest substantive
// session was interrupted (no Session End block) OR ended cleanly with non-empty
// Next Actions.
export function shouldLoadPrior(latest: JournalMeta | null): boolean {
  if (!latest || !latest.isSubstantive) return false;
  if (!latest.isComplete) return true;
  return hasOpenNextActions(latest.content);
}

// Resolve the single prior journal: via previous_session link first, else the
// next-most-recent substantive journal by filename (pre-PR1 back-compat). Caps
// the chain at 2 full journals (latest + this one).
export function selectPriorJournal(
  journalDir: string,
  latest: JournalMeta
): { meta: JournalMeta; viaPreviousSession: boolean } | null {
  const metas = listJournalMetas(journalDir);
  if (latest.previousSession) {
    const linked = metas.find(m => m.sessionId === latest.previousSession && m.isSubstantive);
    if (linked) return { meta: linked, viaPreviousSession: true };
  }
  // Fallback: the next OLDER substantive journal (filename strictly before
  // latest), newest-first - never a newer sibling.
  const fallback = metas.find(m => m.isSubstantive && m.file < latest.file);
  if (fallback) return { meta: fallback, viaPreviousSession: false };
  return null;
}

// The latest journal is always rendered verbatim (project invariant). The prior
// is budgeted: verbatim if under budget, else its summary, else a hard truncation.
export function budgetPriorJournal(meta: JournalMeta, maxTokens: number = 800): string {
  if (estimateTokens(meta.content) <= maxTokens) return meta.content;
  const summary = extractJournalSummary(meta.content);
  if (summary && estimateTokens(summary) <= maxTokens) {
    return `_(prior session - summarized to fit ${maxTokens}-token budget)_\n\n${summary}`;
  }
  const wordBudget = Math.max(1, Math.floor(maxTokens / 1.8));
  const truncated = meta.content.split(/\s+/).slice(0, wordBudget).join(" ");
  return `${truncated}\n\n...[prior session truncated to fit ${maxTokens}-token budget]`;
}
