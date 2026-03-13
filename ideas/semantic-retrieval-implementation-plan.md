# Semantic Retrieval — Implementation Plan

## Overview

Add embedding-based semantic search to memory-mcp. Purely additive — zero breaking changes.
Keyword search remains the foundation; embeddings enhance `contextSearch` when available.

Architecture design in `semantic-retrieval-design.md`. Tool surface changes in `v2-tool-surface-and-retrieval.md`.
This document is the implementation plan grounded in the actual codebase.

## PR strategy

Four PRs, ordered by dependency and risk:

1. **Embedding infrastructure** — new files, no behavior change (steps 1-3)
2. **Extract keywordRank** — pure refactor, regression test, no behavior change (step 4)
3. **Semantic retrieval** — the feature + debug score logging (steps 5-7)
4. **Config, migration, observability** — polish (steps 8-10)

PR 2 is the safety net. If the extraction breaks anything, it is caught before semantic logic is layered on.

---

## Step 1: `embedder.ts` — Types + Implementations

**New file**: `src/embedder.ts`

### Types

```typescript
// types.ts — shared branded type (avoids coupling text-analyzer → embedder)
type EmbeddingVector = Float32Array & { readonly __brand: 'EmbeddingVector' };
```

`EmbeddingVector` lives in `types.ts` alongside `Tag` and `TopicScope`. This keeps
`text-analyzer.ts` dependency-free — it imports the branded type from `types.ts`
(which it could already import), not from `embedder.ts`.

```typescript
// embedder.ts
type EmbedFailure =
  | { readonly kind: 'provider-unavailable'; readonly reason: string }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'invalid-input'; readonly reason: string };

type EmbedResult =
  | { readonly ok: true; readonly vector: EmbeddingVector }
  | { readonly ok: false; readonly failure: EmbedFailure };

interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<EmbedResult>;
  readonly dimensions: number;
}
```

**Design justification:**
- `EmbedResult` discriminated union — [P08] errors are data. Same pattern as existing `StoreResult` / `CorrectResult`.
- `EmbedFailure` union — [P07] exhaustive failure modes. Store logs the kind for observability [P23] even though control flow is the same (keyword fallback).
- `AbortSignal` — [P22] timeouts first-class. Callers control cancellation.
- No `isAvailable()` — redundant with `embed() → { ok: false }`. One path to discover state, not two. [P05] reduce path explosion.
- No `embedBatch()` on interface — [P25] small interfaces. Batch is a standalone utility function that composes over `embed()`.

### OllamaEmbedder

```typescript
class OllamaEmbedder implements Embedder {
  readonly dimensions = 384; // nomic-embed-text

  constructor(
    private readonly model: string = 'nomic-embed-text',
    private readonly baseUrl: string = 'http://localhost:11434',
    private readonly timeoutMs: number = 5000,
  ) {}

  async embed(text: string, signal?: AbortSignal): Promise<EmbedResult> {
    // Validate at boundary [P09]
    if (!text.trim()) return { ok: false, failure: { kind: 'invalid-input', reason: 'empty text' } };

    // Compose caller's signal with internal timeout [P22]
    // Single HTTP POST to /api/embeddings
    // Returns EmbedFailure on ANY error — never throws [P08]
  }
}
```

Uses `node:http` — no npm dependency. HTTP call wrapped in a function that returns `EmbedResult`,
never throws. All error paths (network, timeout, JSON parse, model not loaded) produce
`EmbedFailure` variants.

### FakeEmbedder

Deterministic — uses character trigram frequency to produce a fixed-dimension vector from
input text. Two similar texts produce similar vectors (high cosine similarity).
[P24] fakes over mocks — tests validate the full pipeline with realistic substitutes.
[P11] determinism — same input text always produces the same vector.

**Limitation (elevated from watch item to action):** Trigram vectors model *string* 
similarity, not *semantic* similarity. "async workflows" and "asynchronous work patterns" 
score low despite being semantically identical. FakeEmbedder tests prove pipeline mechanics 
(merge, degradation, round-trip) but can give false confidence that ranking works correctly 
when real embeddings would produce a completely different ordering.

**Mitigation:** Ship a fixture file (`src/__tests__/fixtures/real-vectors.json`) containing 
hardcoded vectors generated from real `nomic-embed-text` output for ~10-15 curated text 
pairs. These fixture vectors are deterministic (frozen, not generated at test time) and 
enable ranking regression tests that validate real semantic ordering:

```typescript
// Example fixture entries:
// "token refresh race condition" ↔ "concurrent auth token updates"  → high similarity
// "Gradle cache invalidation"   ↔ "build system caching gotcha"    → high similarity
// "token refresh race condition" ↔ "CSS grid layout patterns"       → low similarity
```

FakeEmbedder stays for pipeline mechanic tests. Fixture vectors are used for ranking 
ordering tests. Both are needed — they test different things.

### batchEmbed utility

```typescript
async function batchEmbed(
  embedder: Embedder,
  texts: readonly string[],
): Promise<ReadonlyArray<EmbedResult>>
```

Sequential loop over `embed()`. Pure composition — not an interface concern [P25].

### Tests

- `FakeEmbedder`: same text → same vector (determinism). Similar texts → high cosine similarity.
  Dissimilar texts → low cosine similarity. Tests pipeline mechanics only — see limitation above.
- `OllamaEmbedder`: skip in CI. Manual/integration test with local Ollama.
- `batchEmbed`: feeds N texts, returns N results. Handles mixed success/failure.
- **Fixture vectors** (`src/__tests__/fixtures/real-vectors.json`): ~10-15 curated text entries 
  with real `nomic-embed-text` vectors, generated once via a setup script and committed. Used 
  in ranking regression tests (Steps 5, 7) to validate real semantic ordering.

---

## Step 2: `cosineSimilarity` in `text-analyzer.ts`

**What changes**: One new pure function in `text-analyzer.ts`.

```typescript
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

**Why here**: `text-analyzer.ts` is the designated seam for search strategies (lines 4-7).
Cosine similarity sits alongside the existing `jaccardSimilarity` and `containmentSimilarity`.

**Also**: update the header comment in `text-analyzer.ts` to reflect the actual evolution path:
```
// v1: keyword matching with naive stemming (this file)
// v2: embedding-based cosine similarity (this file + embedder.ts)
// v3: graph-enriched retrieval (if proven needed — see graph-library-design.md)
```
The existing "v2: spreading activation over a knowledge graph" is inaccurate — the graph 
library uses typed edge traversal, not spreading activation.

**Dependency**: Imports `EmbeddingVector` from `types.ts` (not from `embedder.ts`).
This preserves `text-analyzer.ts` as a module with no coupling to the embedding provider.

**Performance**: 384 float multiplications per entry. For 200 entries: 76,800 ops. <1ms.

### Tests

- Identical vectors → 1.0
- Orthogonal vectors → 0.0
- Known vectors with precomputed expected similarity
- Zero vector → 0.0 (not NaN)

---

## Step 3: Sidecar `.vec` read/write/delete in `store.ts`

### New private field

```typescript
private vectors: Map<string, EmbeddingVector> = new Map();
private queryEmbedCount: number = 0;        // for first-query timeout (5s vs 2s)
private consecutiveTimeouts: number = 0;    // for mode indicator + bump-back trigger
```

### New private methods

**`persistVector(entry, vector)`** — writes `[uint8 version][uint32 dimensions][float32[]]` 
to `{id}.vec` alongside `{id}.md`.

Format:
- Byte 0: format version (`0x01` for v1). Future-proofs the format for adding metadata 
  (model hash, float16 vectors, etc.) at the cost of 1 byte per file.
- Bytes 1-4: uint32 dimension count. Enables model migration detection on load.
- Bytes 5+: float32 vector data.

Total overhead: 5 bytes. For 384-dim vectors: 5 + 1536 = 1541 bytes per file.

> **Future consideration (YAGNI for now):** A model name hash after the version byte (e.g., 
> 4 bytes of FNV hash of "nomic-embed-text") would distinguish between two models with the 
> same dimensionality but different vector spaces. The version byte makes this a non-breaking 
> addition: v2 format = `[0x02][uint32 dims][uint32 model_hash][float32[]]`.

**`loadVector(entryId, relativePath)`** → `EmbeddingVector | null` — reads `.vec` file,
validates version byte and dimension header against `this.embedder.dimensions`. Returns null on:
- File missing (entry predates embeddings)
- File corrupt (wrong size or unknown version byte)
- Dimension mismatch (model changed — needs `reEmbed`)

Dimension mismatch is **not** an error — it is a known degradation state.
Logged to stderr with a diagnostic message [P23].

**`deleteVector(entry)`** — deletes `.vec` file if it exists. Called from `deleteEntryFile`.

### Changes to existing methods

**`deleteEntryFile()`** (line 697): add `await this.deleteVector(entry)` after `.md` deletion.

**`loadSnapshot()`** (line 715): after loading markdown entries, load vectors into a separate map.
Return type becomes `{ entries, vectors, corruptFileCount }`. Vector loading is a
separate inner function `loadVectorSnapshot()` — [P13] compose with small functions.

When embedder is null, `loadVectorSnapshot` is skipped entirely (no wasted I/O).

**Orphan `.vec` cleanup**: during `loadVectorSnapshot`, any `.vec` file without a matching 
`.md` entry is deleted. This prevents slow accumulation of dead files from entries that were 
deleted while the embedder was unavailable (or from manual file deletions). Fire-and-forget 
delete — failure is logged but doesn't block loading.

**`reloadFromDisk()`** (line 739): assign both `this.entries` and `this.vectors` from snapshot.

### Atomicity acknowledgment

The write path persists `.md` then `.vec` as two separate file operations. Non-atomic.
Failure modes are benign because vectors are derived data:
- `.md` written, `.vec` not → entry works via keyword fallback
- `.md` deleted, `.vec` orphaned → ignored on reload (no matching `.md`)

Deliberate pragmatic tradeoff — temp-dir-and-rename adds complexity for no practical benefit.
Documented, not an oversight.

### Tests

- Write `.vec`, reload, verify round-trip (same vector bytes)
- Write `.vec` with wrong dimensions, reload, verify rejected (returns null)
- Delete entry, verify `.vec` cleaned up
- Orphan `.vec` (no matching `.md`), verify deleted during `loadVectorSnapshot`
- Missing `.vec` → null (not error)
- Embedder null → no `.vec` files loaded, no errors

---

## Step 4: Extract `keywordRank` from `contextSearch` (pure refactor)

### New shared type in `text-analyzer.ts`

```typescript
export interface ScoredEntry {
  readonly entry: MemoryEntry;
  readonly score: number;
  readonly matchedKeywords: readonly string[];
  readonly source: 'keyword' | 'semantic' | 'merged';
}

/** Shared context for ranking functions — groups the parameters that both
 *  keywordRank and semanticRank need, reducing parameter count from 7 to 4. */
export interface RankContext {
  readonly currentBranch: string;
  readonly branchFilter: string | undefined;
  readonly topicBoost: Readonly<Record<string, number>>;
  readonly isFresh: (entry: MemoryEntry) => boolean;
}
```

`ScoredEntry.source` provides observability [P23] — consumers can tell whether a result
came from keyword matching, semantic similarity, or a merge of both. Without it,
`{ score: 0.92, matchedKeywords: [] }` is ambiguous.

`RankContext` groups shared parameters — [P13] reduces `keywordRank` from 7 params to 4.

### New pure function in `text-analyzer.ts`

```typescript
export function keywordRank(
  entries: readonly MemoryEntry[],
  contextKeywords: ReadonlySet<string>,
  minMatch: number,
  ctx: RankContext,
): readonly ScoredEntry[]
```

**This is a pure extraction of lines 569-620 of `store.ts`.** The logic is identical:
iterate entries, compute keyword match ratio, apply topic boost + freshness multiplier +
reference boost + tag boost, filter by minMatch, sort by score.

The "always include user entries" logic (lines 612-616) stays in `contextSearch` —
it is a policy decision, not a ranking concern. `keywordRank` is pure keyword matching.
[P13] — each function does one thing.

**`isFresh` is injected via `RankContext`** — [P17] DI for boundaries. The pure function
does not reach into the store's private staleness logic. It receives a callback.

### Changes to `contextSearch`

Replace the inline loop with:
```typescript
const ctx: RankContext = { currentBranch, branchFilter, topicBoost: TOPIC_BOOST, isFresh: (e) => this.isFresh(e) };
const keywordResults = keywordRank(allEntries, contextKeywords, minMatch, ctx);
```

### Critical regression test

**`contextSearch` with `embedder: null` must produce identical results to the pre-change
implementation for a set of known entries.** This is the safety gate for PR 2.

Test strategy: construct a store with ~20 entries across multiple topics, run contextSearch
with several queries, capture the results BEFORE the refactor, then verify AFTER.

### Tests

- `keywordRank` with known entries and known keywords → expected ordering
- Zero keyword overlap → empty results
- Branch filtering works (recent-work filtered by branch)
- Topic boost applied correctly
- Freshness multiplier applied correctly

---

## Step 5: `semanticRank` and `mergeRankings` pure functions

### New threshold in `thresholds.ts`

```typescript
/** Minimum cosine similarity for semantic search results.
 *  Below this, entries are noise — embedding models produce non-zero similarity
 *  even for unrelated text.
 *
 *  CALIBRATION NOTE: 0.45 is a strict starting point. With nomic-embed-text, 
 *  unrelated text pairs routinely score 0.2-0.4 because the model produces 
 *  non-orthogonal embeddings for any English text. Starting strict and loosening 
 *  with data is safer than starting loose — agents learn to rely on noisy results 
 *  and tightening later causes regressions.
 *
 *  Debug-level semantic score logging (included in this PR — see semanticRank 
 *  below) enables calibration from real queries.
 *
 *  WATCH: Domain-adjacent text (all entries in a lobe are about the same codebase)
 *  will have a higher baseline similarity than random text. Two entries about the 
 *  same app's auth module might score 0.5-0.6 even when covering completely different 
 *  aspects. If 0.45 filters out too many within-lobe results, lobe-specific or 
 *  topic-specific baseline adjustment may be needed. */
export const SEMANTIC_MIN_SIMILARITY = 0.45;

/** Score band for semantic ranking tiebreaker.
 *  Entries within this band of each other are considered equivalently ranked
 *  by the embedding model — keyword score breaks the tie.
 *  Exists because embedding models produce noisy scores: 0.82 vs 0.83 is
 *  indistinguishable signal, not meaningful ranking. */
export const SEMANTIC_SCORE_BAND = 0.05;
```

Named constants in `thresholds.ts` — visible, tunable, documented [P23].
The band is a calibration choice, not a magic number hidden in a function body.

### `semanticRank`

```typescript
export function semanticRank(
  entries: readonly MemoryEntry[],
  vectors: ReadonlyMap<string, EmbeddingVector>,
  queryVector: EmbeddingVector,
  ctx: RankContext,
): readonly ScoredEntry[]
```

For each entry with a vector in the map: compute `cosineSimilarity(queryVector, entryVector)`,
apply topic boost and freshness multiplier (same factors as `keywordRank`), filter below
`SEMANTIC_MIN_SIMILARITY`. Branch filtering applied (recent-work scoped to current branch).

Entries without vectors are silently skipped — they participate via keyword ranking only.

**Debug score logging** (ships with `semanticRank`, not deferred to Step 10):
When `MEMORY_MCP_DEBUG=1` env var is set, log every cosine similarity score to stderr:
```
[memory-mcp:debug] semantic 0.87 gotcha-a1b2 "Token refresh race"
[memory-mcp:debug] semantic 0.43 conv-e5f6   "Result<T> convention"
[memory-mcp:debug] semantic 0.12 arch-i9j0   "Module boundaries"  ← below threshold
```
This is essential for calibrating `SEMANTIC_MIN_SIMILARITY`. You want score distributions
from the first real usage, not after a separate polish PR. [P23] observability.

### `mergeRankings`

```typescript
export function mergeRankings(
  semanticResults: readonly ScoredEntry[],
  keywordResults: readonly ScoredEntry[],
): readonly ScoredEntry[]
```

Strategy:
1. Semantic results are the primary ranking signal
2. For entries within the same semantic score band (±`SEMANTIC_SCORE_BAND`), keyword
   score breaks the tie
3. Entries with only keyword scores (no vector) are appended after all semantic results,
   ranked by keyword score
4. Entries that appear in both lists get `source: 'merged'` and the semantic score
   (since it is the primary signal)

No weighted fusion. No magic 60/40 constants. The merge is a sort with a tiebreaker.
[P11] determinism — when ordering is surprising, you can reason about it.

### Tests

- `semanticRank`: constructed entries + vectors with known cosine scores → expected ordering
- `semanticRank`: entries without vectors → excluded from results
- `mergeRankings`: semantic-first ordering, keyword tiebreaker within band
- `mergeRankings`: keyword-only entries appended after semantic results
- `mergeRankings`: dedup — entry in both lists appears once with `source: 'merged'`

---

## Step 6: Wire embedder into `store()` and `correct()` write paths

### Changes to `MemoryConfig` in `types.ts`

```typescript
import type { Embedder } from './embedder.js';

interface MemoryConfig {
  // ... existing fields ...
  readonly embedder?: Embedder;  // null/absent = keyword-only mode
}
```

### Changes to `store()` (line 155)

After `await this.persistEntry(entry)`:

```typescript
if (this.config.embedder) {
  const embedText = `${title}\n\n${content}`;  // paragraph separator — model trained on paragraph-separated text
  const embedResult = await this.config.embedder.embed(embedText);
  if (embedResult.ok) {
    await this.persistVector(entry, embedResult.vector);
    this.vectors.set(entry.id, embedResult.vector);
  } else {
    process.stderr.write(
      `[memory-mcp] Embedding failed for ${entry.id}: ${embedResult.failure.kind}\n`
    );
  }
}

// Semantic dedup: check cosine similarity against existing vectors.
// We're already embedding at store time — this check is almost free.
// Falls back to keyword dedup (findRelatedEntries) when vectors aren't available.
if (this.config.embedder && embedResult?.ok) {
  const semanticDuplicates = this.findSemanticDuplicates(entry.id, embedResult.vector);
  // Merge with keyword-based relatedEntries (dedup by ID)
}
```

**Awaited, not fire-and-forget.** When `store()` returns, both `.md` and `.vec` exist.
The 10ms embed latency is acceptable for a store call. Fire-and-forget would create a
race condition: an immediately-following `contextSearch` calls `reloadFromDisk` which
would not find the `.vec` that hasn't been written yet. [P20] prefer atomicity.

### Changes to `correct()` (line 402)

After `await this.persistEntry(updated)` for append/replace actions:

```typescript
if (this.config.embedder) {
  const embedText = `${updated.title}\n\n${updated.content}`;
  const embedResult = await this.config.embedder.embed(embedText);
  if (embedResult.ok) {
    await this.persistVector(updated, embedResult.vector);
    this.vectors.set(updated.id, embedResult.vector);
  } else {
    process.stderr.write(
      `[memory-mcp] Re-embedding failed for ${updated.id}: ${embedResult.failure.kind}\n`
    );
  }
}
```

`correct()` modifies content — the old vector is stale. Re-embed on correction.
For delete actions, `deleteEntryFile` already handles `.vec` cleanup (step 3).

### Changes to `store()` for overwrite path (line 148)

When overwriting an existing entry (`existing` found), the old `.vec` is deleted
via `deleteEntryFile(existing)` (which calls `deleteVector` from step 3). The new
entry gets a fresh embed. No orphaned vectors.

### Semantic dedup at store time

Since we embed at store time, checking cosine similarity against existing vectors
is almost free. This replaces keyword-based `findRelatedEntries` when vectors are
available, and falls back to keyword dedup when they aren't.

New private method:

```typescript
private findSemanticDuplicates(
  excludeId: string,
  newVector: EmbeddingVector,
  topic: TopicScope,
): RelatedEntry[]
```

Iterates `this.vectors` for same-topic entries, computes `cosineSimilarity`,
returns entries above `DEDUP_SEMANTIC_THRESHOLD` (new constant in `thresholds.ts`,
calibrate alongside `SEMANTIC_MIN_SIMILARITY`).

In `store()`, merge semantic duplicates with keyword duplicates (dedup by ID,
take the higher similarity score). The combined list is returned as `relatedEntries`
in the store result — same shape, better recall.

**Why now, not deferred**: the tool surface redesign reduces storage friction, which
means agents will store more. More entries + lower friction = more duplicates.
We are already embedding at store time — the cosine check is negligible extra cost.

### Tests

- Store with `FakeEmbedder` → `.vec` file exists alongside `.md`
- Store with embedder returning failure → entry stored, no `.vec`, no error thrown
- Store with `embedder: null` → no `.vec`, no error
- Correct (replace) with embedder → new `.vec` written, old content's vector replaced
- Correct (delete) → `.vec` cleaned up
- Overwrite (same title) → old `.vec` deleted, new `.vec` written
- Semantic dedup: store similar entry → returned in `relatedEntries`
- Semantic dedup fallback: no vectors → keyword dedup still works

---

## Step 7: Wire ranking pipeline into `contextSearch()`

### Rewritten `contextSearch`

```typescript
async contextSearch(
  context: string,
  maxResults: number = 10,
  branchFilter?: string,
  minMatch: number = 0.2,
): Promise<readonly ScoredEntry[]> {
  await this.reloadFromDisk();

  const contextKeywords = extractKeywords(context);

  // Only bail on zero keywords when there's no embedder to fall back on.
  // Stopword-heavy queries like "how things work together" produce zero keywords
  // but can still yield useful semantic results via embeddings.
  if (contextKeywords.size === 0 && !this.config.embedder) return [];

  const currentBranch = branchFilter || await this.getCurrentBranch();
  const allEntries = Array.from(this.entries.values());

  const ctx: RankContext = {
    currentBranch,
    branchFilter,
    topicBoost: TOPIC_BOOST,
    isFresh: (e) => this.isFresh(e),
  };

  // Keyword ranking (works for all entries, may be empty for stopword-heavy queries)
  const keywordResults = contextKeywords.size > 0
    ? keywordRank(allEntries, contextKeywords, minMatch, ctx)
    : [];

  // Semantic ranking (only if embedder available and query embeds)
  let semanticResults: readonly ScoredEntry[] = [];
  if (this.config.embedder) {
    // Timeout strategy:
    // - First query: 5s (cold model load after Ollama eviction)
    // - Normal queries: 2s (model is warm, 10ms typical)
    // - After 3 consecutive timeouts: bump back to 5s for one attempt (re-eviction case)
    //   Without this, a mid-session model eviction causes all subsequent queries to fail
    //   at 2s when they need 5s for a cold load. The LazyEmbedder 5-min reprobe wouldn't
    //   help because the embedder IS available — it's just slow.
    const needsColdTimeout = this.queryEmbedCount === 0 || this.consecutiveTimeouts >= 3;
    const timeoutMs = needsColdTimeout ? 5000 : 2000;
    this.queryEmbedCount++;
    const querySignal = AbortSignal.timeout(timeoutMs);
    const queryResult = await this.config.embedder.embed(context, querySignal);
    if (queryResult.ok) {
      this.consecutiveTimeouts = 0;  // reset on success
      semanticResults = semanticRank(allEntries, this.vectors, queryResult.vector, ctx);
    } else if (queryResult.failure.kind === 'timeout') {
      this.consecutiveTimeouts++;  // tracked for mode indicator + bump-back trigger
    }
    // If embed fails: semanticResults stays empty, keyword results used alone
  }

  // Merge and cap
  const merged = mergeRankings(semanticResults, keywordResults);

  // Policy: always include user entries (even without keyword match)
  for (const entry of this.entries.values()) {
    if (entry.topic === 'user' && !merged.find(r => r.entry.id === entry.id)) {
      merged.push({
        entry,
        score: entry.confidence * USER_ALWAYS_INCLUDE_SCORE_FRACTION,
        matchedKeywords: [],
        source: 'keyword',
      });
    }
  }

  return merged.slice(0, maxResults);
}
```

`contextSearch` is now an orchestrator: reload, extract keywords, call ranking functions,
merge, apply policy (user entries), return. [P13] composition.

The "user entries always included" policy stays in `contextSearch` — it is a business
rule, not a ranking concern.

**Graceful degradation [P21]**: if embedder is null, `semanticResults` is empty,
`mergeRankings` works with keyword-only. Identical to pre-embedding behavior.

### Embed call timeout

The `OllamaEmbedder` has its own timeout (default 5s). But `contextSearch` should not
block for 5s on a cold Ollama. Add a tighter timeout for the query-time embed:

```typescript
const timeoutMs = this.queryEmbedCount === 0 ? 5000 : 2000;
const querySignal = AbortSignal.timeout(timeoutMs);
const queryResult = await this.config.embedder.embed(context, querySignal);
```

Timeout tiers:
- **First query**: 5s — cold model load after Ollama eviction can take 5-10s
- **Normal queries**: 2s — model is warm, 10ms typical. Covers machine-under-load
- **After 3 consecutive timeouts**: bump back to 5s for one attempt — handles mid-session 
  model re-eviction. Without this, eviction causes all subsequent queries to fail at 2s 
  indefinitely (the LazyEmbedder reprobe doesn't help because the embedder IS available, 
  just slow)

Store-time embeds keep the longer 5s timeout since they are less latency-sensitive.

The store tracks `consecutiveTimeouts` (reset on success). The mode indicator in Step 10 
surfaces this: `"semantic + keyword (3 consecutive embed timeouts)"` so degradation caused 
by load or eviction is visible, not silent.

### Critical regression test

**`contextSearch` with `embedder: null` must produce identical results to the pre-change
implementation.** This is the safety gate for PR 3. Tested with the same entry set and
queries as step 4's regression test.

### Return type change (explicit sub-step — do not skip)

`contextSearch` currently returns `Array<{ entry, score, matchedKeywords }>`.
It now returns `readonly ScoredEntry[]` (which adds `source` field). 

**Caller update checklist** — `index.ts` is ~1540 lines with multiple `contextSearch` call 
sites. Each must be updated for the new `ScoredEntry` type. The compiler catches all sites 
([P06] type safety), but enumerate them here to avoid a scramble:

1. `memory_context` handler — reads `entry`, `score`, `matchedKeywords` from results
2. `memory_query` handler — if it delegates to `contextSearch` for fallback
3. `formatContextResults` in `formatters.ts` — renders results for the agent
4. Any test helpers that construct or assert on return values

Walk through all call sites before merging. The `source` field is new — formatters should 
use it for the mode indicator (Step 10) but existing formatters can ignore it until then.

### Tests

- Full pipeline: store entries with FakeEmbedder, contextSearch with semantic query → semantic results ranked first
- Degradation: contextSearch with `embedder: null` → identical to pre-embedding behavior
- Degradation: contextSearch with embedder returning failure → keyword-only results
- User entries always included regardless of search mode
- Query-time timeout: mock slow embedder, verify keyword results returned within timeout
- Stopword-heavy query: `"how do things connect here"` (zero keywords) still returns semantic results when embedder available
- Stopword-heavy query with `embedder: null` → returns empty (no keywords, no embedder)

---

## Step 8: `EmbedderConfig` in types + config + auto-detect

### New types in `types.ts`

```typescript
export type EmbedderProvider = 'ollama' | 'none';

export interface EmbedderConfig {
  readonly provider: EmbedderProvider;
  readonly model?: string;       // default: 'nomic-embed-text'
  readonly baseUrl?: string;     // default: 'http://localhost:11434'
  readonly timeoutMs?: number;   // default: 5000
}
```

[P05] `EmbedderProvider` is `'ollama' | 'none'`, not an open string.

### Config file format

```json
{
  "lobes": { "...": "..." },
  "embedder": {
    "provider": "ollama",
    "model": "nomic-embed-text"
  }
}
```

### Parsing in `config.ts`

Add `embedder?: EmbedderConfig` to `MemoryConfigFile`. Parse alongside behavior config.
Validate `timeoutMs` with `clampThreshold(value, 5000, 500, 30000)`.
Warn on unknown keys (same pattern as `parseBehaviorConfig`).

### Startup behavior in `index.ts`

**Explicit config** (`provider: "ollama"`): create `OllamaEmbedder` at startup. Probe with
`embed("health check")`. If fails, log warning and set embedder to null (degraded mode).
[P10] fail fast — the user asked for Ollama, tell them immediately if it is unavailable.

**Explicit opt-out** (`provider: "none"`): embedder is null. Keyword-only mode. No probe.

**No config** (absent `embedder` block): **lazy auto-detect**. Create a `LazyEmbedder`
wrapper that probes on first `embed()` call and caches the result. This keeps startup
fast — no 5s timeout if Ollama is down. The mode indicator (step 10) shows
"search: detecting..." until the first actual use, then resolves to the real mode.

```typescript
class LazyEmbedder implements Embedder {
  readonly dimensions: number;
  private inner: Embedder | null = null;
  private lastProbeTime: number = 0;

  /** Re-probe interval on failure. If Ollama starts after the initial probe,
   *  the embedder recovers within this window without MCP restart. */
  private static readonly REPROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  async embed(text: string, signal?: AbortSignal): Promise<EmbedResult> {
    const now = Date.now();
    const shouldProbe = !this.inner && (now - this.lastProbeTime > LazyEmbedder.REPROBE_INTERVAL_MS);

    if (shouldProbe) {
      this.lastProbeTime = now;
      const probe = await this.candidate.embed('health check');
      this.inner = probe.ok ? this.candidate : null;
      if (!probe.ok) {
        process.stderr.write(
          `[memory-mcp] Ollama not available — using keyword-only search (will retry in 5m)\n`
        );
      }
    }
    if (!this.inner) return { ok: false, failure: { kind: 'provider-unavailable', reason: 'auto-detect failed' } };
    return this.inner.embed(text, signal);
  }
}
```

[P21] graceful degradation — auto-detect never fails, just degrades. Failed probes
retry after 5 minutes so the system recovers if Ollama starts after MCP startup.
[P17] DI — `LazyEmbedder` implements the same `Embedder` interface. The store doesn't know.

### Tests

- Config parsing: valid config → correct `EmbedderConfig`
- Config parsing: unknown keys → warning logged
- Config parsing: out-of-range `timeoutMs` → clamped to default
- Explicit `provider: "none"` → embedder null
- `LazyEmbedder`: first call probes, subsequent calls use cached result
- `LazyEmbedder`: probe failure → returns failure, re-probes after 5m TTL
- `LazyEmbedder`: probe failure then Ollama becomes available → recovers on next probe

---

## Step 9: `reEmbed()` + `memory_reembed` hidden tool

### New method on `MarkdownMemoryStore`

```typescript
async reEmbed(): Promise<{
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly dimensionMismatch: number;
}>
```

Iterates all entries. For each:
- Valid `.vec` with matching dimensions → skip
- Valid `.vec` with wrong dimensions → delete old `.vec`, re-embed (counts as `dimensionMismatch`)
- Missing `.vec` → embed
- Embed failure → increment `failed`

Uses sequential `embed()` calls (not `batchEmbed` — simpler, and the tool is a cold-path
utility, not a hot path). [P19] YAGNI.

### New hidden tool in `index.ts`

Same pattern as `memory_diagnose` / `memory_stats`. Tool name: `memory_reembed`.
Response includes the counts and a summary:

```
Re-embedded 47 entries (3 skipped, 2 failed, 5 dimension mismatches).
```

### Hint in `contextSearch`

When >50% of entries lack vectors and embedder is available, append a hint to the
context response: "Tip: run memory_reembed to generate embeddings for N entries."
Informational, never blocking.

### Tests

- Store 5 entries without embedder. Call `reEmbed` with `FakeEmbedder` → 5 embedded, 0 skipped
- Call again → 0 embedded, 5 skipped (idempotent)
- Change embedder dimensions → all 5 count as dimension mismatch, re-embedded
- Embed failure for 1 entry → 4 embedded, 1 failed

---

## Step 10: Mode indicator in context responses

### Changes to `formatters.ts`

New function:

```typescript
export function formatSearchMode(
  embedderAvailable: boolean,
  vectorizedCount: number,
  totalCount: number,
  dimensionMismatchCount: number,
): string
```

Output variants:
- `*Search: semantic + keyword (47/52 entries vectorized)*`
- `*Search: semantic + keyword (47/52 entries vectorized, 3 consecutive embed timeouts)*`
- `*Search: semantic + keyword (47/52 entries vectorized, 5 dimension mismatches — run memory_reembed)*`
- `*Search: keyword-only (embedder unavailable — install Ollama for semantic search)*`
- `*Search: keyword-only (no entries vectorized — run memory_reembed)*`

The timeout counter makes load-induced degradation visible. Without it, the system
silently falls back to keyword-only under load and no one notices.

### Changes to `index.ts`

Pass vector coverage stats to the formatter when building context/recall responses.
The stats are computed from `store.vectors.size` and `store.entries.size` (expose via
a read-only accessor or include in the `contextSearch` return).

### Note on debug score logging

Debug-level semantic score logging is implemented in Step 5 (`semanticRank`), not here.
It ships with PR3 so score distributions are available from the first real usage.
Step 10 only adds the user-facing mode indicator and timeout counter to responses.

### Tests

- Each output variant renders correctly
- Dimension mismatch message only shown when count > 0
- Timeout counter displayed when > 0, hidden when 0

---

## Dependency graph

```
Step 1 (embedder.ts) ──┐
Step 2 (cosine sim)  ──┤── independent, parallelizable
Step 4 (keywordRank) ──┘

Step 3 (sidecar .vec) ── depends on Step 1 types (EmbeddingVector in types.ts)

Step 5 (semanticRank) ── depends on Steps 1, 2

Step 6 (wire store)   ── depends on Steps 1, 3

Step 7 (wire search)  ── depends on Steps 4, 5, 6

Step 8 (config)       ── depends on Step 1 types

Step 9 (reEmbed)      ── depends on Steps 1, 3, 6

Step 10 (mode display)── depends on Step 7
```

Steps 1, 2, and 4 can run in parallel — zero dependencies on each other.

---

## Files changed per step

| Step | New files | Modified files |
|---|---|---|
| 1 | `src/embedder.ts`, `src/__tests__/embedder.test.ts` | `src/types.ts` (add `EmbeddingVector`) |
| 2 | — | `src/text-analyzer.ts` (add `cosineSimilarity`) |
| 3 | — | `src/store.ts` (add vector field, persist/load/delete methods, wire into deleteEntryFile + loadSnapshot + reloadFromDisk) |
| 4 | — | `src/text-analyzer.ts` (add `ScoredEntry`, `RankContext`, `keywordRank`), `src/store.ts` (contextSearch calls keywordRank) |
| 5 | — | `src/text-analyzer.ts` (add `semanticRank`, `mergeRankings`), `src/thresholds.ts` (add `SEMANTIC_MIN_SIMILARITY`, `SEMANTIC_SCORE_BAND`) |
| 6 | — | `src/types.ts` (add `embedder?` to MemoryConfig), `src/store.ts` (embed in store + correct) |
| 7 | — | `src/store.ts` (rewrite contextSearch as orchestrator) |
| 8 | — | `src/types.ts` (add `EmbedderConfig`, `EmbedderProvider`), `src/config.ts` (parse embedder block), `src/index.ts` (startup logic + LazyEmbedder) |
| 9 | — | `src/store.ts` (add reEmbed), `src/index.ts` (add memory_reembed tool + hint) |
| 10 | — | `src/formatters.ts` (add formatSearchMode), `src/index.ts` (pass stats to formatter) |

---

## Known future enhancements (explicitly deferred)

- **`findRelevantPreferences` using embeddings** — currently keyword-based. Could use cosine similarity for better preference surfacing when storing non-preference entries. Lower priority than dedup (which is now in scope via Step 6).
- **Semantic pre-filter for `query()`** — `memory_query` stays keyword-only. A future hybrid: semantic top-N candidates → keyword post-filter (AND/OR/NOT) could make query benefit from semantic recall.
- **Graph library integration** — typed relationships (`contradicts`, `supersedes`) enrich retrieval results beyond what embeddings provide. Separate design in `graph-library-design.md`. Depends on embeddings being proven first.

---

## Acceptance criteria

1. `contextSearch` with `embedder: null` produces **identical** results to pre-change behavior (regression gate)
2. `contextSearch` with embeddings finds entries that keyword search misses (the "FlowCoordinator state machine" test case)
3. Stopword-heavy queries produce semantic results when embedder is available
4. Semantic dedup at store time catches duplicates that keyword dedup misses
5. All existing tests pass with zero modification
6. Embedding failure at any point degrades to keyword-only, never crashes
7. `LazyEmbedder` recovers if Ollama becomes available after initial failure
8. Mode indicator in responses shows current search state
9. `reEmbed` is idempotent — running it twice produces the same result
10. No new npm dependencies (uses `node:http` for Ollama)
11. Ranking regression tests using real `nomic-embed-text` fixture vectors validate semantic ordering
12. Orphan `.vec` files (no matching `.md`) are cleaned up during reload
