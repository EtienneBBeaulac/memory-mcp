// Response formatters for MCP tool handlers.
//
// Pure functions — no side effects, no state. Each takes structured data
// and returns a formatted string for the tool response.

import type { MemoryStats, StaleEntry, ConflictPair, BehaviorConfig } from './types.js';
import {
  DEFAULT_STALE_DAYS_STANDARD, DEFAULT_STALE_DAYS_PREFERENCES,
  DEFAULT_MAX_STALE_IN_BRIEFING, DEFAULT_MAX_DEDUP_SUGGESTIONS, DEFAULT_MAX_CONFLICT_PAIRS,
} from './thresholds.js';

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
  const lines = ['⚠ Potential conflicts detected:'];
  for (const c of conflicts) {
    lines.push(`  - ${c.a.id}: "${c.a.title}" (confidence: ${c.a.confidence}, created: ${c.a.created.substring(0, 10)})`);
    lines.push(`    vs ${c.b.id}: "${c.b.title}" (confidence: ${c.b.confidence}, created: ${c.b.created.substring(0, 10)})`);
    lines.push(`    Similarity: ${(c.similarity * 100).toFixed(0)}%`);

    // Guide the agent on which entry to trust
    if (c.a.confidence !== c.b.confidence) {
      const higher = c.a.confidence > c.b.confidence ? c.a : c.b;
      lines.push(`    Higher confidence: ${higher.id} (${higher.confidence})`);
    } else {
      const newer = c.a.created > c.b.created ? c.a : c.b;
      lines.push(`    More recent: ${newer.id} — may supersede the older entry`);
    }
  }
  lines.push('');
  lines.push('Consider: memory_correct to consolidate or clarify the difference between these entries.');
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

  const corruptLine = result.corruptFiles > 0 ? `\n**Corrupt files:** ${result.corruptFiles}` : '';

  return [
    `## [${lobe}] Memory Stats`,
    ``,
    `**Memory location:** ${result.memoryPath}`,
    `**Total entries:** ${result.totalEntries}${corruptLine}`,
    `**Storage:** ${result.storageSize} / ${Math.round(result.storageBudgetBytes / 1024 / 1024)}MB budget`,
    ``,
    `### By Topic`,
    topicLines || '  (none)',
    ``,
    `### By Trust Level`,
    trustLines,
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
