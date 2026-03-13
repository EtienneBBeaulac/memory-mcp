// Domain ranking functions — scoring MemoryEntries using text analysis primitives.
// Pure functions: no I/O, no side effects, deterministic.
//
// Separated from text-analyzer.ts (which works on strings/sets, not domain types)
// and from store.ts (which handles orchestration and persistence).
// This module is the ranking pipeline seam for keyword, semantic, and merged ranking.

import type { MemoryEntry } from './types.js';
import {
  REFERENCE_BOOST_MULTIPLIER,
  MODULE_TOPIC_BOOST,
  TAG_MATCH_BOOST,
} from './thresholds.js';
import { extractKeywords, stem } from './text-analyzer.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** A scored search result. Shared return type for all ranking functions. */
export interface ScoredEntry {
  readonly entry: MemoryEntry;
  readonly score: number;
  readonly matchedKeywords: readonly string[];
}

/** Shared context for ranking functions — pure data, no callbacks.
 *  Groups the parameters that keywordRank (and later semanticRank) need,
 *  keeping function signatures tight.
 *
 *  freshEntryIds is precomputed by the store — the ranking function checks
 *  set membership rather than calling into the store's private staleness logic.
 *  This keeps the function provably pure. */
export interface RankContext {
  readonly currentBranch: string;
  readonly branchFilter: string | undefined;
  readonly topicBoost: Readonly<Record<string, number>>;
  readonly freshEntryIds: ReadonlySet<string>;
}

// ─── Keyword ranking ───────────────────────────────────────────────────────

/** Rank entries by keyword overlap with context keywords.
 *  Pure extraction of the ranking logic from contextSearch — identical scoring.
 *
 *  Filter + rank in one pass for efficiency (~200 entries, not worth two iterations).
 *  Branch filtering for recent-work is applied here because it's a pre-condition
 *  for ranking, not a separate pipeline stage.
 *
 *  Does NOT include the "always include user entries" policy — that's an
 *  orchestration concern that stays in contextSearch. */
export function keywordRank(
  entries: readonly MemoryEntry[],
  contextKeywords: ReadonlySet<string>,
  minMatch: number,
  ctx: RankContext,
): readonly ScoredEntry[] {
  const results: ScoredEntry[] = [];

  for (const entry of entries) {
    // Filter recent-work by branch (unless branchFilter is "*")
    if (entry.topic === 'recent-work' && ctx.branchFilter !== '*' && entry.branch && entry.branch !== ctx.currentBranch) {
      continue;
    }

    // Include tag values as keywords so tagged entries surface in context search
    const tagKeywordPart = entry.tags ? ` ${entry.tags.join(' ')}` : '';
    const entryKeywords = extractKeywords(`${entry.title} ${entry.content}${tagKeywordPart}`);
    const matchedKeywords: string[] = [];

    for (const kw of contextKeywords) {
      if (entryKeywords.has(kw)) matchedKeywords.push(kw);
    }

    if (matchedKeywords.length === 0) continue;

    // Enforce minimum match threshold
    const matchRatio = matchedKeywords.length / contextKeywords.size;
    if (matchRatio < minMatch) continue;

    // Score = keyword match ratio × confidence × topic boost × freshness × reference boost × tag boost
    const boost = ctx.topicBoost[entry.topic] ?? (entry.topic.startsWith('modules/') ? MODULE_TOPIC_BOOST : 1.0);
    const freshnessMultiplier = ctx.freshEntryIds.has(entry.id) ? 1.0 : 0.7;

    // Reference boost: exact class/file name match in references gets a 1.3x multiplier
    const referenceBoost = entry.references?.some(ref => {
      const basename = ref.split('/').pop()?.replace(/\.\w+$/, '') ?? ref;
      return contextKeywords.has(stem(basename.toLowerCase()));
    }) ? REFERENCE_BOOST_MULTIPLIER : 1.0;

    // Tag boost: if any tag exactly matches a context keyword, boost the entry
    const tagBoost = entry.tags?.some(tag => contextKeywords.has(tag))
      ? TAG_MATCH_BOOST : 1.0;

    const score = matchRatio * entry.confidence * boost * freshnessMultiplier * referenceBoost * tagBoost;

    results.push({ entry, score, matchedKeywords });
  }

  return results.sort((a, b) => b.score - a.score);
}
