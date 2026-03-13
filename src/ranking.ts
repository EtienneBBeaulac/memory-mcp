// Domain ranking functions — scoring MemoryEntries using text analysis primitives.
// Pure functions: no I/O, no side effects, deterministic.
//
// Separated from text-analyzer.ts (which works on strings/sets, not domain types)
// and from store.ts (which handles orchestration and persistence).
// This module is the ranking pipeline seam for keyword, semantic, and merged ranking.

import type { MemoryEntry, EmbeddingVector } from './types.js';
import {
  REFERENCE_BOOST_MULTIPLIER,
  TAG_MATCH_BOOST,
} from './thresholds.js';
import { extractKeywords, stem, cosineSimilarity } from './text-analyzer.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Which ranking signal produced this result. */
export type RankSource = 'keyword' | 'semantic' | 'merged';

/** A scored search result. Shared return type for all ranking functions. */
export interface ScoredEntry {
  readonly entry: MemoryEntry;
  readonly score: number;
  readonly matchedKeywords: readonly string[];
  readonly source: RankSource;
  /** Raw cosine similarity before boost multiplication.
   *  Present for semantic and merged results; absent for keyword-only.
   *  Used for debug logging (threshold calibration) and display. */
  readonly semanticSimilarity?: number;
}

/** Shared context for ranking functions — pure data, no callbacks.
 *  Groups the parameters that keywordRank and semanticRank need,
 *  keeping function signatures tight.
 *
 *  freshEntryIds is precomputed by the store — the ranking function checks
 *  set membership rather than calling into the store's private staleness logic.
 *  This keeps the function provably pure.
 *
 *  defaultModuleBoost is the fallback boost for modules/* topics not in topicBoost.
 *  Injected here so ranking.ts needs zero direct threshold imports. */
export interface RankContext {
  readonly currentBranch: string;
  readonly branchFilter: string | undefined;
  readonly topicBoost: Readonly<Record<string, number>>;
  readonly freshEntryIds: ReadonlySet<string>;
  readonly defaultModuleBoost: number;
}

// ─── Shared helpers ────────────────────────────────────────────────────────

/** Resolve topic boost for an entry. Falls back to defaultModuleBoost for
 *  modules/* topics, or 1.0 for unknown topics. */
function getTopicBoost(topic: string, ctx: RankContext): number {
  return ctx.topicBoost[topic] ?? (topic.startsWith('modules/') ? ctx.defaultModuleBoost : 1.0);
}

/** Check whether a recent-work entry should be filtered out by branch. */
function isBranchFiltered(entry: MemoryEntry, ctx: RankContext): boolean {
  return entry.topic === 'recent-work'
    && ctx.branchFilter !== '*'
    && !!entry.branch
    && entry.branch !== ctx.currentBranch;
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
    if (isBranchFiltered(entry, ctx)) continue;

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
    const boost = getTopicBoost(entry.topic, ctx);
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

    results.push({ entry, score, matchedKeywords, source: 'keyword' });
  }

  return results.sort((a, b) => b.score - a.score);
}

// ─── Semantic ranking ──────────────────────────────────────────────────────

/** Rank entries by cosine similarity between query embedding and stored vectors.
 *  Pure function — no I/O, no side effects.
 *
 *  Entries without vectors are silently skipped — they participate via keyword ranking only.
 *  Branch filtering applied (recent-work scoped to current branch).
 *
 *  @param minSimilarity Minimum cosine similarity to include. Caller provides the
 *    threshold (SEMANTIC_MIN_SIMILARITY for production, 0 for debug mode to see all scores). */
export function semanticRank(
  entries: readonly MemoryEntry[],
  vectors: ReadonlyMap<string, EmbeddingVector>,
  queryVector: EmbeddingVector,
  minSimilarity: number,
  ctx: RankContext,
): readonly ScoredEntry[] {
  const results: ScoredEntry[] = [];

  for (const entry of entries) {
    if (isBranchFiltered(entry, ctx)) continue;

    const entryVector = vectors.get(entry.id);
    if (!entryVector) continue;

    const similarity = cosineSimilarity(queryVector, entryVector);
    if (similarity < minSimilarity) continue;

    // Score = cosine similarity × confidence × topic boost × freshness
    // No reference/tag boost — those are keyword-domain signals captured by keywordRank
    const boost = getTopicBoost(entry.topic, ctx);
    const freshnessMultiplier = ctx.freshEntryIds.has(entry.id) ? 1.0 : 0.7;
    const score = similarity * entry.confidence * boost * freshnessMultiplier;

    results.push({
      entry,
      score,
      matchedKeywords: [],
      source: 'semantic',
      semanticSimilarity: similarity,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

// ─── Merge ─────────────────────────────────────────────────────────────────

/** Merge keyword and semantic ranking results using max-score strategy.
 *  For each entry: final score = max(keywordScore, semanticScore).
 *  Entries in both lists get source: 'merged', preserving matchedKeywords from
 *  keyword result and semanticSimilarity from semantic result.
 *
 *  No weighted fusion, no magic constants. Deterministic — same inputs, same output. */
export function mergeRankings(
  keywordResults: readonly ScoredEntry[],
  semanticResults: readonly ScoredEntry[],
): readonly ScoredEntry[] {
  // Index keyword results by entry ID for O(1) lookup during merge
  const keywordById = new Map<string, ScoredEntry>();
  for (const r of keywordResults) {
    keywordById.set(r.entry.id, r);
  }

  const merged = new Map<string, ScoredEntry>();

  // Process semantic results — check for keyword counterpart
  for (const sem of semanticResults) {
    const kw = keywordById.get(sem.entry.id);
    if (kw) {
      // Entry in both lists — use max score, merge signals
      merged.set(sem.entry.id, {
        entry: sem.entry,
        score: Math.max(sem.score, kw.score),
        matchedKeywords: kw.matchedKeywords,       // from keyword (semantic has none)
        source: 'merged',
        semanticSimilarity: sem.semanticSimilarity, // from semantic
      });
      keywordById.delete(sem.entry.id);  // consumed
    } else {
      // Semantic-only
      merged.set(sem.entry.id, sem);
    }
  }

  // Remaining keyword-only results
  for (const kw of keywordById.values()) {
    merged.set(kw.entry.id, kw);
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}
