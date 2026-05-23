export interface ContinuityDigest {
  lastSessions: string[];
  openThreads: string[];
  decisions: string[];
  nextActions: string[];
}

function extractListItems(section: string): string[] {
  return section
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => l
      .replace(/^[-*]\s*\[\s*\]\s*/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[\.)]\s+/, ""))
    .filter(Boolean);
}

function filterPlaceholders(items: string[]): string[] {
  return items.filter(s =>
    s !== "*None this session*" &&
    s !== "*None specified*" &&
    s !== "*None*" &&
    s !== "*No prior sessions*"
  );
}

export function parseDigestFromMemory(memoryContent: string): ContinuityDigest | null {
  const digestMatch = memoryContent.match(/## Continuity Digest\n([\s\S]*?)(?=\n## \d{4}|\n---\n|$)/);
  if (!digestMatch) return null;
  const body = digestMatch[1];

  const sessionsMatch = body.match(/### Last 3 Sessions\n([\s\S]*?)(?=\n### |$)/);
  const openMatch = body.match(/### Open Threads\n([\s\S]*?)(?=\n### |$)/);
  const decisionsMatch = body.match(/### Decisions\/Constraints\n([\s\S]*?)(?=\n### |$)/);
  const nextMatch = body.match(/### Next Actions\n([\s\S]*?)(?=\n### |\n---|$)/);

  return {
    lastSessions: sessionsMatch ? filterPlaceholders(extractListItems(sessionsMatch[1])) : [],
    openThreads: openMatch ? filterPlaceholders(extractListItems(openMatch[1])) : [],
    decisions: decisionsMatch ? filterPlaceholders(extractListItems(decisionsMatch[1])) : [],
    nextActions: nextMatch ? filterPlaceholders(extractListItems(nextMatch[1])) : [],
  };
}

export function formatCarryForwardBlock(digest: ContinuityDigest | null): string {
  let out = "## Carry-Forward from Previous Session\n\n";
  if (!digest || (
    digest.lastSessions.length === 0 &&
    digest.openThreads.length === 0 &&
    digest.decisions.length === 0 &&
    digest.nextActions.length === 0
  )) {
    return out + "*No prior continuity digest available*\n";
  }

  if (digest.openThreads.length > 0) {
    out += "### Open Threads\n" + digest.openThreads.map(t => `- [ ] ${t}`).join("\n") + "\n\n";
  }
  if (digest.decisions.length > 0) {
    out += "### Decisions/Constraints\n" + digest.decisions.map(d => `- ${d}`).join("\n") + "\n\n";
  }
  if (digest.nextActions.length > 0) {
    out += "### Next Actions\n" + digest.nextActions.map((a, i) => `${i + 1}. ${a}`).join("\n") + "\n";
  }
  return out.trim() + "\n";
}
