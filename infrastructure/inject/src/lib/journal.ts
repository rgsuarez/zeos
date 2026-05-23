import * as fs from "node:fs";
import * as path from "node:path";
import { expandPath } from "../path-resolver.js";

export const JOURNAL_SCHEMA_VERSION = "2.0.0";
const STUB_BODY_THRESHOLD = 100;

function getFrontmatterStatus(content: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const match = fm[1].match(/^status:\s*(\S+)/m);
  return match ? match[1].trim() : "";
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

export function getLatestJournal(journalDir: string): string | null {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) return null;

  const files = fs.readdirSync(expanded)
    .filter(f => f.endsWith(".md"))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  for (const file of files) {
    const filePath = path.join(expanded, file);
    const content = fs.readFileSync(filePath, "utf-8");
    if (getFrontmatterStatus(content) === "active") continue;
    const withoutFrontmatter = content.replace(/^---[\s\S]*?---\s*/, "");
    if (withoutFrontmatter.trim().length > STUB_BODY_THRESHOLD) {
      return content;
    }
  }

  for (const file of files) {
    const filePath = path.join(expanded, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const withoutFrontmatter = content.replace(/^---[\s\S]*?---\s*/, "");
    if (withoutFrontmatter.trim().length > STUB_BODY_THRESHOLD) {
      return content;
    }
  }

  return fs.readFileSync(path.join(expanded, files[0]), "utf-8");
}

export function createJournalStub(
  journalDir: string,
  agentName: string,
  app: { app_id?: string } | null = null,
  carryForward: string = ""
): string {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) {
    fs.mkdirSync(expanded, { recursive: true });
  }

  const date = new Date().toISOString().split("T")[0];
  const created = new Date().toISOString();

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

export function checkParallelInstances(journalDir: string): string[] {
  const expanded = expandPath(journalDir);
  if (!fs.existsSync(expanded)) return [];

  const date = new Date().toISOString().split("T")[0];
  const todayJournals = fs.readdirSync(expanded)
    .filter(f => f.startsWith(date) && f.endsWith(".md"));

  const activeInstances: string[] = [];
  for (const journal of todayJournals) {
    const content = fs.readFileSync(path.join(expanded, journal), "utf-8");
    if (getFrontmatterStatus(content) === "active") {
      const match = journal.match(/\d{4}-\d{2}-\d{2}-\d{3}-(.+)\.md/);
      if (match) activeInstances.push(match[1]);
    }
  }

  return activeInstances;
}
