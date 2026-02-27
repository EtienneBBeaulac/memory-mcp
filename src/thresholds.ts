// Central threshold definitions for the memory MCP.
//
// Split into two categories intentionally:
//
//   INTERNAL — calibrated against the text-analyzer algorithm (Jaccard + containment hybrid).
//   Changing these without understanding the similarity function produces confusing results.
//   Not exposed to users.
//
//   USER-FACING — control how the system behaves for the user's workflow.
//   Exposed via memory-config.json under a top-level "behavior" key.
//   All have sensible defaults; the user only needs to set what they want to change.

// ─── Internal algorithm thresholds ─────────────────────────────────────────
// These are properties of the similarity function, not user preferences.

/** Minimum similarity score for dedup detection at write time (same-topic). */
export const DEDUP_SIMILARITY_THRESHOLD = 0.35;

/** Minimum similarity score for conflict detection at query time — same topic.
 *  Higher threshold since same-topic overlaps are often legitimate variations. */
export const CONFLICT_SIMILARITY_THRESHOLD_SAME_TOPIC = 0.60;

/** Minimum similarity score for conflict detection at query time — cross topic.
 *  Lower threshold: if entries in different topics overlap this much, they're
 *  likely talking about the same architectural decision, which is suspicious. */
export const CONFLICT_SIMILARITY_THRESHOLD_CROSS_TOPIC = 0.42;

/** Minimum similarity score for surfacing relevant preferences (cross-topic). */
export const PREFERENCE_SURFACE_THRESHOLD = 0.20;

/** Minimum content length (chars) for conflict detection — short entries are too noisy. */
export const CONFLICT_MIN_CONTENT_CHARS = 50;

/** Opposition keyword pairs for enhanced conflict detection.
 *  When entries overlap AND use opposing terms, boost the conflict signal. */
export const OPPOSITION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['use', 'avoid'],
  ['always', 'never'],
  ['prefer', 'avoid'],
  ['required', 'forbidden'],
  ['mandatory', 'optional'],
  ['sync', 'async'],
  ['mutable', 'immutable'],
  ['mvi', 'mvvm'],
  ['sealed class', 'sealed interface'],
  ['inheritance', 'composition'],
  ['throw', 'return'],       // exceptions vs Result types
  ['imperative', 'declarative'],
];

/** Score multiplier when a reference path basename matches the context keywords. */
export const REFERENCE_BOOST_MULTIPLIER = 1.30;

/** Score multiplier applied to weak cross-lobe results in multi-lobe context search.
 *  Prevents generic software terms (e.g. "codebase", "structure") from surfacing
 *  entries from unrelated repos with high confidence/topic-boost scores. */
export const CROSS_LOBE_WEAK_SCORE_PENALTY = 0.50;

/** Fraction of context keywords an entry must match to avoid the cross-lobe penalty.
 *  E.g. 0.40 means an entry must match at least 40% of the context keywords (minimum 2)
 *  to be treated as a strong cross-lobe match. */
export const CROSS_LOBE_MIN_MATCH_RATIO = 0.40;

/** Per-topic scoring boost factors for contextSearch().
 *  Higher = more likely to surface for any given context. */
export const TOPIC_BOOST: Record<string, number> = {
  user: 2.0,          // always surface identity
  preferences: 1.8,   // almost always relevant
  gotchas: 1.5,       // high-value warnings
  conventions: 1.2,   // coding patterns
  architecture: 1.0,  // baseline
  'recent-work': 0.9, // slightly deprioritized (branch-filtered separately)
};

/** Boost for module-scoped topics not in TOPIC_BOOST. */
export const MODULE_TOPIC_BOOST = 1.1;

/** User entry score when included by default (no keyword match). */
export const USER_ALWAYS_INCLUDE_SCORE_FRACTION = 0.5;

// ─── User-facing behavior defaults ─────────────────────────────────────────
// These are exposed via memory-config.json "behavior" block.
// All values below are the defaults used when the user has not configured them.

/** Days since lastAccessed before a standard entry (arch, conv, gotchas, etc.) goes stale. */
export const DEFAULT_STALE_DAYS_STANDARD = 30;

/** Days since lastAccessed before a preferences entry goes stale.
 *  Longer than standard because coding preferences evolve slowly. */
export const DEFAULT_STALE_DAYS_PREFERENCES = 90;

/** Maximum stale entries surfaced in a single briefing.
 *  Keeps the briefing actionable without overwhelming the agent. */
export const DEFAULT_MAX_STALE_IN_BRIEFING = 5;

/** Maximum dedup suggestions returned when storing a new entry. */
export const DEFAULT_MAX_DEDUP_SUGGESTIONS = 3;

/** Maximum conflict pairs surfaced per query/context response. */
export const DEFAULT_MAX_CONFLICT_PAIRS = 2;

/** Maximum related preferences surfaced when storing a non-preference entry. */
export const DEFAULT_MAX_PREFERENCE_SUGGESTIONS = 3;

/** Score multiplier when an entry's tags match context keywords in contextSearch(). */
export const TAG_MATCH_BOOST = 1.5;

/** Maximum tags shown in vocabulary echo after a store operation. */
export const VOCABULARY_ECHO_LIMIT = 8;

/** Maximum tags shown in query/context footer. */
export const MAX_FOOTER_TAGS = 12;
