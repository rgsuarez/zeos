import { parseMemoryMd, type MemoryEntry } from "./memory.js";

export function findMemoryByTags(
  activeContent: string,
  archiveContent: string,
  tags: string[]
): MemoryEntry[] {
  const want = tags.map(t => t.toLowerCase()).filter(Boolean);
  if (want.length === 0) return [];

  const parsed = parseMemoryMd(activeContent, archiveContent);
  const all = [...parsed.entries, ...parsed.archivedEntries];
  return all.filter(entry => {
    const lower = entry.tags.map(tag => tag.toLowerCase());
    return want.every(tag => lower.includes(tag));
  });
}
