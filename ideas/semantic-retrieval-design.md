# Semantic Retrieval for memory-mcp

## Problem

`contextSearch` and `query` use keyword extraction + naive stemming + Jaccard/containment similarity. This fails on associative recall — the highest-value retrieval pattern:

- Stored: "FlowCoordinator uses a state machine with side effects derived from state transitions"
- Query: "how do we handle async workflows in coordinators"
- Keyword overlap: near zero. Entry is invisible.

The `text-analyzer.ts` header already anticipated this evolution:

```
// v1: keyword matching with naive stemming (this file)
// v2: spreading activation over a knowledge graph
// v3: embedding-based cosine similarity
```

## Design Constraints

From the design-thinking doc and coding philosophy:

- **Fully local** — no cloud API calls. "Must not require external services."
- **<100ms retrieval** — hard constraint. Embedding lookup is O(n) dot products over small N (~hundreds of entries per lobe), trivially fast.
- **Graceful degradation** — if embedding provider is unavailable, fall back to keyword search (existing v1). Not a flag day.
- **Stateless safety model preserved** — embeddings are a cache, not a source of truth. Markdown files remain canonical.
- **Human-readable storage preserved** — embeddings stored alongside, never replacing, markdown.
- **Immutability** — embedding vectors are computed once on store, read many times. Never mutated in place.
- **Small, pure, composable functions** — ranking strategies are independent pure functions composed by an orchestrator.
- **Errors are data** — embedding failures represented as values, not exceptions.
- **Timeouts are first-class** — embed calls have bounded latency.
- **Interface segregation** — the embedder interface exposes only what the store needs.

## Architecture

### New module: `embedder.ts`

A pure boundary interface — the only seam that touches the embedding provider.

```typescript
type EmbeddingVector = Float32Array & { readonly __brand: 'EmbeddingVector' };

/** Why embedding failed — discriminated union for observability.
 *  The store doesn't branch on the reason (always falls back to keywords),
 *  but structured errors enable logging and diagnostics. */
type EmbedFailure =
  | { readonly kind: 'provider-unavailable'; readonly reason: string }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'invalid-input'; readonly reason: string };

type EmbedResult =
  | { readonly ok: true; readonly vector: EmbeddingVector }
  | { readonly ok: false; readonly failure: EmbedFailure };

/** Embedding provider boundary — injected into the store.
 *  Implementations: OllamaEmbedder (production), FakeEmbedder (tests).
 *
 *  Minimal interface: one method + one property.
 *  Batch embedding is a utility function, not an interface concern.
 *  Availability checking is implicit — just call embed() and inspect the result. */
interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<EmbedResult>;
  readonly dimensions: number;
}
```

Design decisions:
- **No `isAvailable()`** — redundant with `embed()` returning a failure. One path to discover provider state, not two.
- **No `embedBatch()`** — interface segregation. The store only needs single-embed. Batch is a utility: `batchEmbed(embedder: Embedder, texts: string[]): Promise<EmbedResult[]>`.
- **`EmbedResult` over `null`** — errors are data. The store logs the failure kind for observability even though control flow is the same (keyword fallback).
- **`AbortSignal`** — timeouts are first-class. Callers control cancellation.

### Production implementation: `OllamaEmbedder`

```typescript
class OllamaEmbedder implements Embedder {
  readonly dimensions = 384; // nomic-embed-text

  constructor(
    private readonly model: string = 'nomic-embed-text',
    private readonly baseUrl: string = 'http://localhost:11434',
    private readonly timeoutMs: number = 5000,
  ) {}

  async embed(text: string, signal?: AbortSignal): Promise<EmbedResult> {
    // Single HTTP POST to /api/embeddings
    // AbortSignal composed with internal timeout
    // Returns EmbedFailure on any error (network, timeout, model not loaded)
  }
}
```

Why `nomic-embed-text`? 384 dimensions, 137MB, runs on CPU in ~10ms per embedding. Sweet spot for local inference — good quality, tiny model, fast.

### Batch utility (standalone function, not on interface)

```typescript
/** Batch embed with concurrency control. Pure composition over Embedder.embed(). */
async function batchEmbed(
  embedder: Embedder,
  texts: readonly string[],
  concurrency: number = 1,
): Promise<ReadonlyArray<EmbedResult>> { ... }
```

### Vector storage: sidecar `.vec` files

Each markdown entry `arch-e8d4f012.md` gets a companion `arch-e8d4f012.vec`.

```
.git/memory/
  architecture/
    arch-e8d4f012.md        # canonical entry (unchanged)
    arch-e8d4f012.vec       # 4-byte dimension header + float32 vector
  conventions/
    conv-a1b2c3d4.md
    conv-a1b2c3d4.vec
```

#### File format

```
[uint32 dimensions][float32 x dimensions]
```

- First 4 bytes: little-endian uint32 storing the dimension count.
- Remaining bytes: raw float32 array.
- Total size: `4 + (dimensions * 4)` bytes. For 384-dim: 1,540 bytes.

The dimension header enables model migration detection. On load, if the stored dimension doesn't match `embedder.dimensions`, the vector is discarded (triggers re-embed on next `reEmbed` call).

Design decisions:
- **Sidecar files, not embedded in markdown** — human-readable storage preserved. Embeddings are a cache; delete all `.vec` files and the system degrades to keyword search.
- **Sidecar files, not a single index file** — concurrency safety. One-file-per-entry means two MCP processes never conflict. A single index reintroduces coordination.
- **Dimension header, not implicit size validation** — validate at boundaries. Explicit is better than inferring dimensions from file size.

### Atomicity acknowledgment

The write path persists `.md` then `.vec` as two separate file operations. This is non-atomic. Failure modes:

- `.md` written, `.vec` not: entry works via keyword fallback. Harmless.
- `.md` deleted, `.vec` orphaned: ignored on reload (no matching `.md`). Harmless.

Both failure modes are benign because vectors are derived data, not canonical state. A temp-dir-and-rename dance would make this atomic but adds complexity for no practical benefit given the failure modes. This is a deliberate pragmatic tradeoff, not an oversight.

### Store integration

Changes to `MarkdownMemoryStore`:

```typescript
class MarkdownMemoryStore {
  private readonly embedder: Embedder | null;     // null = keyword-only mode
  private vectors: Map<string, EmbeddingVector>;   // loaded alongside entries
}
```

#### Write path (`store()`)

```
1. Persist markdown entry (existing, unchanged)
2. If embedder available:
   a. Embed "${title} ${title} ${content}" (title doubled for weight, matching keyword extraction)
   b. If ok: write .vec sidecar, cache in this.vectors
   c. If failed: log failure, continue (entry works via keywords)
```

#### Read path (`reloadFromDisk()`)

```
1. Load markdown files (existing, unchanged)
2. For each entry, try loading companion .vec file
3. Validate dimension header matches embedder.dimensions
4. If missing, corrupt, or dimension mismatch: entry has no vector (keyword fallback)
```

#### Delete path (`deleteEntryFile()`)

```
1. Delete .md file (existing)
2. Delete .vec file if it exists (new)
3. Clean up empty parent directories (existing)
```

### Ranking: composable pure functions

The ranking pipeline is decomposed into small, pure, independently testable functions.

```typescript
interface ScoredEntry {
  readonly entry: MemoryEntry;
  readonly score: number;
  readonly matchedKeywords: readonly string[];
}

/** Keyword-based ranking — existing contextSearch logic extracted as a pure function.
 *  Same inputs always produce same outputs. No I/O. */
function keywordRank(
  entries: readonly MemoryEntry[],
  contextKeywords: ReadonlySet<string>,
  currentBranch: string,
  branchFilter: string | undefined,
  minMatch: number,
): readonly ScoredEntry[]

/** Semantic ranking — cosine similarity against a query vector.
 *  Pure function: no I/O, no side effects. */
function semanticRank(
  entries: readonly MemoryEntry[],
  vectors: ReadonlyMap<string, EmbeddingVector>,
  queryVector: EmbeddingVector,
  currentBranch: string,
  branchFilter: string | undefined,
): readonly ScoredEntry[]

/** Merge two ranked lists. Semantic is the primary ranking signal;
 *  keyword score breaks ties and boosts entries with exact name matches.
 *  
 *  Strategy: rank by semantic score. For entries within the same semantic
 *  score band (±0.05), use keyword score as tiebreaker. Entries with only
 *  keyword scores (no vector) are appended after all semantic results,
 *  ranked by keyword score.
 *
 *  No magic weight constants. The merge is a sort with a tiebreaker,
 *  not a weighted sum. Predictable, debuggable. */
function mergeRankings(
  semanticResults: readonly ScoredEntry[],
  keywordResults: readonly ScoredEntry[],
): readonly ScoredEntry[]
```

Design decisions:
- **Semantic-first with keyword tiebreaker, not weighted fusion** — no magic 60/40 constants. "Determinism over cleverness." When an entry ranks unexpectedly, you can reason about it: "it ranked high because of semantic similarity" or "it won a tiebreak because of keyword match." Transparent.
- **Three pure functions composed by `contextSearch`** — each independently testable. `contextSearch` becomes an orchestrator, not a monolith.
- **Entries without vectors gracefully participate** — they go through keyword ranking only and are appended after semantic results. No entry is silently dropped.

### `contextSearch` (orchestrator)

```typescript
async contextSearch(context, maxResults, branchFilter, minMatch) {
  await this.reloadFromDisk();

  const contextKeywords = extractKeywords(context);
  const currentBranch = await this.getCurrentBranch();
  const allEntries = Array.from(this.entries.values());

  // Always run keyword ranking (works for all entries)
  const keywordResults = keywordRank(allEntries, contextKeywords, currentBranch, branchFilter, minMatch);

  // Run semantic ranking if embedder available and query embeds successfully
  const queryEmbedResult = await this.embedder?.embed(context);
  const semanticResults = (queryEmbedResult?.ok)
    ? semanticRank(allEntries, this.vectors, queryEmbedResult.vector, currentBranch, branchFilter)
    : [];

  // Merge and take top N
  const merged = mergeRankings(semanticResults, keywordResults);
  return merged.slice(0, maxResults);
}
```

### What stays keyword-only

`memory_query` uses `matchesFilter` — boolean AND/OR/NOT gates over stemmed keywords and tags. This stays keyword-only because:

1. Boolean filters compose naturally with keyword matching, not with embedding similarity.
2. `query` is the precision tool; `contextSearch` is the fuzzy/associative tool. Different jobs.

Future path: a hybrid pre-filter (semantic top-N candidates) followed by keyword post-filter (AND/OR/NOT on the narrowed set) could make `query` benefit from semantic recall. This is a separate enhancement, not part of this design.

### `cosineSimilarity` in `text-analyzer.ts`

```typescript
/** Cosine similarity between two embedding vectors.
 *  Returns 0.0-1.0 (embeddings are normalized by most providers).
 *  Pure function, no allocations. */
function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
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

384 float multiplications per entry. For 200 entries: 76,800 operations. <1ms on any modern CPU.

### Configuration

Extend `MemoryConfig` and `memory-config.json`:

```typescript
// types.ts
type EmbedderProvider = 'ollama' | 'none';

interface EmbedderConfig {
  readonly provider: EmbedderProvider;
  readonly model?: string;      // default: 'nomic-embed-text'
  readonly baseUrl?: string;    // default: 'http://localhost:11434'
  readonly timeoutMs?: number;  // default: 5000
}

// In MemoryConfig
interface MemoryConfig {
  // ... existing fields ...
  readonly embedder?: EmbedderConfig;  // absent = auto-detect
}
```

```json
{
  "lobes": { "...": "..." },
  "embedder": {
    "provider": "ollama",
    "model": "nomic-embed-text"
  }
}
```

Auto-detect behavior (when `embedder` config absent):
1. Attempt a single embed call at startup (embed the string "health check").
2. If succeeds: enable semantic search, log to stderr.
3. If fails: log failure reason to stderr, continue with keyword-only.
4. Never fail startup because of embedding availability.

When `provider: "none"`: embedder is null, keyword-only mode. Explicit opt-out.

### Migration: `reEmbed()`

```typescript
/** Re-embed all entries missing or outdated vectors. Idempotent.
 *  Skips entries with valid .vec files matching current dimensions. */
async reEmbed(): Promise<{
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
}>
```

Triggered by:
- Hidden tool `memory_reembed` (like `memory_diagnose`).
- Opportunistic: on `contextSearch`, if >50% of entries lack vectors and embedder is available, log a hint suggesting `memory_reembed`.

Not triggered automatically on `reloadFromDisk` — that's the hot path (every tool call). Embedding is 10ms/entry; 200 entries = 2 seconds. Unacceptable on hot path.

### Degradation ladder

Extends the existing Running / Degraded / Safe Mode ladder:

| State | Embedder | Behavior |
|---|---|---|
| **Full** | Available, all entries have vectors | Semantic + keyword merge |
| **Partial** | Available, some entries lack vectors | Semantic for vectorized entries, keyword for rest, merged |
| **Keyword-only** | Unavailable (Ollama down/not installed) | Existing behavior, zero regression |

The `memory_context` response indicates the search mode:

```
## [workrail] Context: "reducer state machine pattern"
*Search: semantic + keyword (47/52 entries vectorized)*
```

Or in degraded mode:

```
*Search: keyword-only (embedder unavailable — install Ollama for semantic search)*
```

### Testing

- **`FakeEmbedder`** — deterministic. Hashes input text to a fixed vector using character trigram overlap. Two similar texts produce similar vectors. Tests the full merge pipeline without Ollama.
- **`cosineSimilarity`** — pure function, trivial to unit test with known vectors.
- **Degradation regression** — test that `contextSearch` with `embedder: null` produces identical results to current behavior. Guards against regressions.
- **Sidecar lifecycle** — test .vec created on store, loaded on init, deleted on `correct(action: "delete")`.
- **Dimension mismatch** — test that changing embedder dimensions discards stale vectors.
- **Timeout** — test that embed timeout returns `EmbedFailure { kind: 'timeout' }` and store proceeds.
- **Ranking functions** — `keywordRank`, `semanticRank`, `mergeRankings` are pure functions. Test each independently with constructed inputs.

### What stays unchanged

- `memory_query` — keyword/tag search, unmodified
- `matchesFilter`, `parseFilter`, `computeRelevanceScore` — all stay as-is
- Markdown entry format — zero changes
- `memory_store` API — no new parameters (embedding is transparent)
- Dedup detection — stays keyword-based (works well for same-topic near-duplicates)
- Conflict detection — stays keyword-based
- All existing tests — zero breakage

### Implementation order

1. `embedder.ts` — `Embedder` interface, `EmbedResult`, `OllamaEmbedder`, `FakeEmbedder`, `batchEmbed` utility
2. `cosineSimilarity` in `text-analyzer.ts`
3. Sidecar `.vec` read/write/delete in `store.ts` — `persistVector`, `loadVector`, `deleteVector`
4. Extract `keywordRank` from existing `contextSearch` (pure refactor, no behavior change)
5. Add `semanticRank` and `mergeRankings`
6. Wire embedder into `store()` write path
7. Wire ranking pipeline into `contextSearch()`
8. `EmbedderConfig` in types, parsed in `config.ts`, auto-detect in startup
9. `reEmbed()` + `memory_reembed` hidden tool
10. Mode indicator in context response formatting

Steps 1-3 are isolated and fully testable. Step 4 is a pure refactor with no behavior change (regression test opportunity). Steps 5-7 are the core integration. Steps 8-10 are polish.

### Dependency

One new runtime dependency: `node:http` (or `node:https`) for Ollama API calls. No external npm packages — the HTTP call is simple enough to use Node's built-in client.
