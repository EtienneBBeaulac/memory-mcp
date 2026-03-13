// Response formatters for MCP tool handlers.
//
// Pure functions — no side effects, no state. Each takes structured data
// and returns a formatted string for the tool response.

import type { MemoryStats, StaleEntry, ConflictPair, BehaviorConfig } from './types.js';
import {
  DEFAULT_STALE_DAYS_STANDARD, DEFAULT_STALE_DAYS_PREFERENCES,
  DEFAULT_MAX_STALE_IN_BRIEFING, DEFAULT_MAX_DEDUP_SUGGESTIONS, DEFAULT_MAX_CONFLICT_PAIRS,
  MAX_FOOTER_TAGS, WARN_SEPARATOR,
} from './thresholds.js';
import { analyzeFilterGroups, type FilterGroup, type QueryMode } from './text-analyzer.js';
import type { MarkdownMemoryStore } from './store.js';

/** Format the search mode indicator for context/recall responses.
 *  Pure function — no I/O, no state.
 *
 *  Shows whether semantic search is active and vector coverage. */
export function formatSearchMode(
  embedderAvailable: boolean,
  vectorCount: number,
  totalCount: number,
): string {
  if (!embedderAvailable) {
    return '*Search: keyword-only (install Ollama for semantic search)*';
  }
  if (vectorCount === 0 && totalCount > 0) {
    return `*Search: semantic + keyword (0/${totalCount} entries vectorized — run memory_reembed)*`;
  }
  if (totalCount === 0) {
    return '*Search: semantic + keyword (no entries yet)*';
  }
  return `*Search: semantic + keyword (${vectorCount}/${totalCount} entries vectorized)*`;
}

/** Format the stale entries section for briefing/context responses */
export function formatStaleSection(staleDetails: readonly StaleEntry[]): string {
  const lines = [
    `📋 ${staleDetails.length} stale ${staleDetails.length === 1 ? 'entry' : 'entries'} — verify accuracy or delete:`,
    ...staleDetails.map(e => `  - ${e.id}: "${e.title}" (last accessed ${e.daysSinceAccess} days ago)`),
    '',
    'If still accurate: memory_correct(id: "...", action: "append", correction: "") — refreshes the timestamp',
    'If outdated: memory_correct(id: "...", action: "replace", correction: "<updated content>") or action: "delete"',
  ];
  return lines.join('\n');
}

/** Format the conflict detection warning for query/context responses */
export function formatConflictWarning(conflicts: readonly ConflictPair[]): string {
  const lines = [
    WARN_SEPARATOR,
    '⚠  CONFLICTING ENTRIES DETECTED — ACTION NEEDED  ⚠',
    WARN_SEPARATOR,
  ];
  for (const c of conflicts) {
    lines.push(`  ${c.a.id}: "${c.a.title}" (confidence: ${c.a.confidence}, ${c.a.created.substring(0, 10)})`);
    lines.push(`    vs`);
    lines.push(`  ${c.b.id}: "${c.b.title}" (confidence: ${c.b.confidence}, ${c.b.created.substring(0, 10)})`);
    lines.push(`  Similarity: ${(c.similarity * 100).toFixed(0)}%`);
    lines.push('');

    // Pre-fill which entry to delete so the agent can act immediately.
    if (c.a.confidence !== c.b.confidence) {
      const keep = c.a.confidence > c.b.confidence ? c.a : c.b;
      const remove = c.a.confidence > c.b.confidence ? c.b : c.a;
      lines.push(`  Trust ${keep.id} (higher confidence). Delete the lower-confidence entry:`);
      lines.push(`  memory_correct(id: "${remove.id}", action: "delete")`);
    } else {
      const keep = c.a.created > c.b.created ? c.a : c.b;
      const remove = c.a.created > c.b.created ? c.b : c.a;
      lines.push(`  ${keep.id} is more recent — may supersede ${remove.id}:`);
      lines.push(`  memory_correct(id: "${remove.id}", action: "delete")`);
    }
    lines.push('');
  }
  lines.push(WARN_SEPARATOR);
  return lines.join('\n');
}

/** Format memory stats for a single lobe or global store */
export function formatStats(lobe: string, result: MemoryStats): string {
  const topicLines = Object.entries(result.byTopic)
    .map(([topic, count]) => `  - ${topic}: ${count}`)
    .join('\n');

  const trustLines = Object.entries(result.byTrust)
    .map(([trust, count]) => `  - ${trust}: ${count}`)
    .join('\n');

  const tagLines = Object.entries(result.byTag).length > 0
    ? Object.entries(result.byTag)
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => `  - ${tag}: ${count}`)
        .join('\n')
    : '  (none)';

  const corruptLine = result.corruptFiles > 0 ? `\n**Corrupt files:** ${result.corruptFiles}` : '';
  const vectorLine = `\n**Vectors:** ${result.vectorCount}/${result.totalEntries} entries vectorized`;

  return [
    `## [${lobe}] Memory Stats`,
    ``,
    `**Memory location:** ${result.memoryPath}`,
    `**Total entries:** ${result.totalEntries}${corruptLine}${vectorLine}`,
    `**Storage:** ${result.storageSize} / ${Math.round(result.storageBudgetBytes / 1024 / 1024)}MB budget`,
    ``,
    `### By Topic`,
    topicLines || '  (none)',
    ``,
    `### By Trust Level`,
    trustLines,
    ``,
    `### By Tag`,
    tagLines,
    ``,
    `### Freshness`,
    `  - Fresh: ${result.byFreshness.fresh}`,
    `  - Stale: ${result.byFreshness.stale}`,
    `  - Unknown: ${result.byFreshness.unknown}`,
    ``,
    result.oldestEntry ? `Oldest: ${result.oldestEntry}` : '',
    result.newestEntry ? `Newest: ${result.newestEntry}` : '',
  ].filter(Boolean).join('\n');
}

/** Format the active behavior config section for diagnostics.
 *  Shows effective values and marks overrides vs defaults clearly. */
export function formatBehaviorConfigSection(behavior?: BehaviorConfig): string {
  const effectiveStaleStandard = behavior?.staleDaysStandard ?? DEFAULT_STALE_DAYS_STANDARD;
  const effectiveStalePrefs = behavior?.staleDaysPreferences ?? DEFAULT_STALE_DAYS_PREFERENCES;
  const effectiveMaxStale = behavior?.maxStaleInBriefing ?? DEFAULT_MAX_STALE_IN_BRIEFING;
  const effectiveMaxDedup = behavior?.maxDedupSuggestions ?? DEFAULT_MAX_DEDUP_SUGGESTIONS;
  const effectiveMaxConflict = behavior?.maxConflictPairs ?? DEFAULT_MAX_CONFLICT_PAIRS;

  const hasOverrides = behavior && Object.keys(behavior).length > 0;

  const tag = (val: number, def: number) => val !== def ? ' ← overridden' : ' (default)';

  const lines = [
    `- staleDaysStandard: ${effectiveStaleStandard}${tag(effectiveStaleStandard, DEFAULT_STALE_DAYS_STANDARD)}`,
    `- staleDaysPreferences: ${effectiveStalePrefs}${tag(effectiveStalePrefs, DEFAULT_STALE_DAYS_PREFERENCES)}`,
    `- maxStaleInBriefing: ${effectiveMaxStale}${tag(effectiveMaxStale, DEFAULT_MAX_STALE_IN_BRIEFING)}`,
    `- maxDedupSuggestions: ${effectiveMaxDedup}${tag(effectiveMaxDedup, DEFAULT_MAX_DEDUP_SUGGESTIONS)}`,
    `- maxConflictPairs: ${effectiveMaxConflict}${tag(effectiveMaxConflict, DEFAULT_MAX_CONFLICT_PAIRS)}`,
  ];

  if (!hasOverrides) {
    lines.push('');
    lines.push('All defaults active. To customize, add a "behavior" block to memory-config.json:');
    lines.push('  { "behavior": { "staleDaysStandard": 14, "staleDaysPreferences": 60, "maxStaleInBriefing": 3 } }');
  }

  return lines.join('\n');
}

/** Merge tag frequencies from multiple stores — pure function over a collection */
export function mergeTagFrequencies(
  stores: Iterable<MarkdownMemoryStore>,
): ReadonlyMap<string, number> {
  const merged = new Map<string, number>();
  
  for (const store of stores) {
    const freq = store.getTagFrequency();
    for (const [tag, count] of freq) {
      merged.set(tag, (merged.get(tag) ?? 0) + count);
    }
  }
  
  return merged;
}

/** Build query footer — pure function, same inputs → same output.
 *  Accepts parsed FilterGroup[] to avoid reparsing. */
export function buildQueryFooter(opts: {
  readonly filterGroups: readonly FilterGroup[];
  readonly rawFilter: string | undefined;
  readonly tagFreq: ReadonlyMap<string, number>;
  readonly resultCount: number;
  readonly scope: string;
}): string {
  const { filterGroups, rawFilter, tagFreq, resultCount, scope } = opts;
  const mode = analyzeFilterGroups(filterGroups);
  const lines: string[] = [];
  
  // 1. Query mode explanation
  switch (mode.kind) {
    case 'no-filter':
      lines.push(`Showing all entries in scope "${scope}"`);
      break;
    case 'keyword-only':
      lines.push(`Searched keywords: ${mode.terms.join(', ')} (stemmed)`);
      break;
    case 'tag-only':
      lines.push(`Filtered by tags: ${mode.tags.map(t => `#${t}`).join(', ')} (exact match)`);
      break;
    case 'complex':
      const features: string[] = [];
      if (mode.hasTags) features.push('#tags');
      if (mode.hasExact) features.push('=exact');
      if (mode.hasNot) features.push('-NOT');
      if (mode.hasOr) features.push('|OR');
      lines.push(`Complex filter: ${features.join(', ')}`);
      break;
  }
  
  // 2. Available tags (always shown, capped for readability)
  if (tagFreq.size > 0) {
    const topTags = [...tagFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_FOOTER_TAGS)
      .map(([tag, count]) => `${tag}(${count})`)
      .join(', ');
    const remainder = tagFreq.size > MAX_FOOTER_TAGS ? ` + ${tagFreq.size - MAX_FOOTER_TAGS} more` : '';
    lines.push(`Available tags: ${topTags}${remainder}`);
  }
  
  // 3. Zero-results suggestion (adaptive) — only when using keywords and tags exist
  if (resultCount === 0 && mode.kind === 'keyword-only' && tagFreq.size > 0) {
    const topTag = [...tagFreq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    lines.push(`→ No keyword matches. Try: filter: "#${topTag}" for exact category.`);
  }
  
  // 4. Syntax reference — show on failure or complex queries (not on simple successful queries)
  if (resultCount === 0 || mode.kind === 'complex') {
    lines.push(`Syntax: #tag | =exact | -NOT | word (stemmed) | A B (AND) | A|B (OR)`);
  }
  
  return lines.join('\n');
}

/** Build tag primer section for session briefing — pure function */
export function buildTagPrimerSection(
  tagFreq: ReadonlyMap<string, number>,
  lobeName?: string,
): string {
  if (tagFreq.size === 0) return '';
  
  const allTags = [...tagFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => `${tag}(${count})`)
    .join(', ');
  
  return [
    lobeName
      ? `### Tag Vocabulary — ${lobeName} (${tagFreq.size} tags)`
      : `### Tag Vocabulary (${tagFreq.size} tags)`,
    allTags,
    ``,
    `Filter by tags: memory_query(filter: "#auth") — exact match`,
    `Combine: memory_query(filter: "#auth middleware") — tag + keyword`,
    `Multiple: memory_query(filter: "#auth|#security") — OR logic`,
  ].join('\n');
}
 
/** Build briefing tag primer sections without merging vocabularies across lobes. */
export function buildBriefingTagPrimerSections(
  lobeTagFrequencies: Iterable<readonly [string, ReadonlyMap<string, number>]>,
): readonly string[] {
  const nonEmpty = Array.from(lobeTagFrequencies)
    .filter(([, tagFreq]) => tagFreq.size > 0);
  const includeLobeNames = nonEmpty.length > 1;
  return nonEmpty.map(([lobeName, tagFreq]) =>
    buildTagPrimerSection(tagFreq, includeLobeNames ? lobeName : undefined)
  );
}
