const IMPORTANCE_DEFAULT = 3;

export interface BridgeSections {
  objective?: string;
  state?: string;
  openThreads?: string[];
  verified?: string[];
  assumed?: string[];
  blockers?: string[];
  deadEnds?: string[];
  nextTacticalMove?: string;
  delta?: string;
}

export function firstContentLine(text: string): string {
  const line = text
    .split("\n")
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith("#") && !l.match(/^[-*]\s*$/));
  return line || "Session continuity update";
}

export function titleFromSummary(summary: string): string {
  return firstContentLine(summary)
    .replace(/^[-*]\s*/, "")
    .substring(0, 150);
}

export function stripListMarker(line: string): string {
  return line
    .replace(/^-\s*\[\s*\]\s*/, "")
    .replace(/^(?:[-*]\s*|\d+[\.)]\s*)/, "")
    .trim();
}

export function normalizeStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(item => normalizeStringList(item)).filter(Boolean);
  }
  return String(value)
    .split(/\n|,/)
    .map(item => stripListMarker(item.trim()))
    .filter(Boolean);
}

export function normalizeTags(value: unknown): string[] {
  return [...new Set(normalizeStringList(value)
    .map(tag => tag.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean))]
    .slice(0, 12);
}

export function clampImportance(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return IMPORTANCE_DEFAULT;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

export function formatListSection(items: string[], checkbox: boolean = false): string {
  if (items.length === 0) return "";
  return items.map(item => `${checkbox ? "- [ ]" : "-"} ${item}`).join("\n");
}

export function buildBridgeContent(sections: BridgeSections): string {
  const parts: string[] = [];
  if (sections.objective?.trim()) parts.push(`### Objective\n${sections.objective.trim()}`);
  if (sections.state?.trim()) parts.push(`### State of the World\n${sections.state.trim()}`);
  if (sections.openThreads?.length) parts.push(`### Open Threads\n${formatListSection(sections.openThreads, true)}`);
  if (sections.verified?.length) parts.push(`### Verified\n${formatListSection(sections.verified)}`);
  if (sections.assumed?.length) parts.push(`### Assumed\n${formatListSection(sections.assumed)}`);
  if (sections.blockers?.length) parts.push(`### Blockers\n${formatListSection(sections.blockers)}`);
  if (sections.deadEnds?.length) parts.push(`### Dead Ends\n${formatListSection(sections.deadEnds)}`);
  if (sections.nextTacticalMove?.trim()) parts.push(`### Next Tactical Move\n${sections.nextTacticalMove.trim()}`);
  if (sections.delta?.trim()) parts.push(`### Delta\n${sections.delta.trim()}`);
  return parts.join("\n\n").trim();
}
