# Typed Graph Library — Shared Infrastructure for Knowledge Relationships

## Status

- **Type**: Parking lot / vision document — illustrative, not locked. Schemas and specifics 
  will evolve if and when implementation begins. The core types (Phase 0) are the stable 
  foundation; consumer schemas are sketches showing why the library *could* be worth building.
- **Phase**: No timeline. Revisit after 3-6 months of real usage with embeddings + new tool 
  surface. Only pursue if retrieval quality plateaus and typed relationships demonstrably 
  add value over "here are the 5 most similar entries." None of the three consumers exist 
  as graph consumers today — building shared infrastructure for unproven requirements 
  violates YAGNI.
- **Related**: `semantic-retrieval-design.md`, `v2-tool-surface-and-retrieval.md`
- **Related (storyforge)**: `docs/local-graph-slice.md`, `docs/architecture/decisions/0011-local-first-graph-retrieval.md`

## Core idea

A domain-agnostic typed graph library that provides storage, traversal, schema validation, provenance, and compilation primitives. Three consumers bring their own schemas and compilers:

- **memory-mcp** — relationships between knowledge entries (gotchas, conventions, architecture)
- **storyforge** — story entity graph (characters, promises, locations, chapters)
- **etienne-clone** — review knowledge graph (principles, patterns, past findings)

The library is infrastructure. It does not know about gotchas, characters, or review findings. Each consumer defines their own node types, edge types, compilers, and query surfaces on top of the shared primitives.

## Why a shared library changes the calculus

The graph was previously dismissed for memory-mcp alone because embeddings cover the retrieval need at ~200 entries and the edge formation discipline problem was unsolved.

As a shared library:

- **Cost amortized** — implementation effort divided across three consumers
- **Each consumer validates independently** — if the abstraction works for story entities, knowledge entries, AND review findings, it is probably right
- **Storyforge does not reinvent** — the local graph slice (`compiled-graph.json`, node types, provenance) builds on the library rather than from scratch
- **Typed relationships carry information embeddings cannot** — "similar" and "contradicts" are both "nearby" to cosine similarity, but they have opposite implications for the consumer

## What the library provides

### Core types

```typescript
/** A typed node. Consumer provides the NodeType union via generic. */
interface GraphNode<NodeType extends string> {
  readonly id: string;
  readonly type: NodeType;
  readonly data: Record<string, unknown>;
  readonly provenance: readonly SourceRef[];
  readonly scope?: string;
  readonly createdAt: string;
}

/** A typed edge. Consumer provides the EdgeType union via generic. */
interface GraphEdge<EdgeType extends string> {
  readonly source: string;
  readonly target: string;
  readonly type: EdgeType;
  readonly weight?: number;
  readonly provenance: readonly SourceRef[];
  readonly scope?: string;
}

/** Where this derived fact came from. Every node and edge must trace to source. */
interface SourceRef {
  readonly path: string;
  readonly sourceKind: string;
  readonly section?: string;
  readonly scope?: string;
}
```

### Capabilities

1. **Storage** — read/write/delete nodes and edges. Pluggable backend: flat JSON file, sidecar files, or future database.
2. **Schema validation** — enforce that node and edge types conform to a consumer-defined schema. Invalid types fail at write time, not silently accepted.
3. **Traversal primitives** — neighbors by type, BFS/DFS with depth limit, filtered walks, multi-hop path finding.
4. **Provenance tracking** — every derived item traces to source artifacts. Library enforces non-empty provenance on write.
5. **Compilation pipeline** — "given source artifacts, produce a graph." Deterministic: same inputs always produce same graph. Full rebuild first; incremental later.
6. **Query primitives** — the building blocks consumers compose into domain-specific queries. Not a query language — a set of composable functions.

### What each consumer brings

Each consumer provides three things:

- **Schema** — the node type union and edge type union (TypeScript discriminated unions)
- **Compiler** — how to extract nodes and edges from their specific source artifacts
- **Query surface** — domain-specific functions built on the traversal primitives

The library validates the schema; the consumer defines it.

## Consumer: memory-mcp (illustrative — will evolve)

### Schema

```typescript
type MemoryNodeType = 'gotcha' | 'convention' | 'preference' | 'architecture' | 'progress';
type MemoryEdgeType = 'supersedes' | 'contradicts' | 'applies_to' | 'depends_on' | 'exemplifies';
```

### Edge semantics

| Edge type | Meaning | Example |
|---|---|---|
| `supersedes` | This entry replaces an older one | New auth convention supersedes the old one |
| `contradicts` | These entries conflict — surface both with warning | "Use Result<T>" vs "Use exceptions for auth errors" |
| `applies_to` | This gotcha applies to a specific module/area | "Gradle cache breaks" applies to "build system" architecture |
| `depends_on` | Understanding this requires understanding that | "Payments module" depends on "auth module architecture" |
| `exemplifies` | This entry is an example of that pattern | A specific gotcha exemplifies a convention |

### Compiler: edge auto-detection

Memory-mcp entries are natural language, not structured YAML. Edges must be inferred, not manually declared. Strategies for automatic edge detection at store time:

1. **Embedding similarity** — if new entry is highly similar to existing entry (cosine > threshold), candidate for `supersedes` or `contradicts`
2. **Contradiction detection** — negation language ("but actually", "not", "unlike", opposite claims) between similar entries → `contradicts`
3. **Same-topic newer entry** — high similarity + same topic + newer timestamp → candidate `supersedes`
4. **Module/area reference matching** — entry mentions a module name that appears in an architecture entry → `applies_to`
5. **Sampling (MCP capability)** — the MCP server can ask the LLM to classify the relationship between a new entry and its nearest neighbors. Most accurate, but adds latency. Optional, background.

Edge auto-detection is heuristic — it will produce some wrong edges. This is acceptable because:

- Edges are derived data, not canonical state. Wrong edges can be deleted without data loss.
- The graph enhances retrieval (enriches results with relationship context) but does not gate it (embeddings and keywords still find entries independently).
- Over time, `fix` can correct bad edges, and heuristics can be tuned.

### How the graph enhances retrieval

Embeddings and graph compose — they do not compete:

```
1. Embed the query → find top-N entries by cosine similarity (embeddings)
2. For each result, traverse graph edges 1-2 hops (graph)
3. Annotate results with relationship types (graph)
4. Return enriched result set:
   - "Auth convention [conv-a1b2]" — CONTRADICTED BY "Auth exception pattern [conv-x1y2]"
   - "Gradle cache gotcha [gotcha-e8d4]" — APPLIES TO "Build system architecture [arch-f012]"
```

Without the graph, `recall("auth")` returns entries ranked by relevance. With the graph, the same results include typed relationship context — contradictions are surfaced together, superseded entries are demoted or flagged, and dependencies pull in related entries the agent might not have found by keyword or embedding alone.

### Query surface for memory-mcp

```typescript
// Built on library traversal primitives
function getContradictions(entryId: string): readonly GraphEdge<'contradicts'>[];
function getSuperseded(entryId: string): readonly GraphNode<MemoryNodeType>[];
function getRelatedGotchas(area: string): readonly GraphNode<'gotcha'>[];
function enrichResults(entries: ScoredEntry[]): EnrichedScoredEntry[];
```

## Consumer: storyforge (illustrative — will evolve)

### Schema

```typescript
type StoryNodeType = 'chapter' | 'scene' | 'character' | 'promise' | 'location' | 'world_rule';
type StoryEdgeType = 'appears_in' | 'introduced_in' | 'resolved_in' | 'constrains' | 'affects';
```

This is the schema from storyforge's ADR 0022 and `local-graph-slice.md`. The library provides the graph engine; storyforge provides the schema and compiler.

### Compiler

Deterministic. Parses canonical YAML artifacts + validated chapter summaries → typed graph. Full rebuild from source every time (matching storyforge's ADR 0022: "full rebuild semantics first").

```typescript
function compileStoryGraph(
  projectRoot: string,
  schema: StoryGraphSchema,
): CompiledGraph<StoryNodeType, StoryEdgeType>
```

### Query surface

```typescript
function getEntitiesForChapter(graph, chapterId): GraphNode<StoryNodeType>[];
function getActivePromises(graph, chapterId): GraphNode<'promise'>[];
function getConstraints(graph, chapterId): GraphNode<'world_rule'>[];
function getCharacterState(graph, characterId, chapterId): CharacterBundle;
function buildRoleContextBundle(graph, role, chapterId): ContextBundle;
```

These are the task-oriented query functions from `local-graph-slice.md`. The library provides the traversal; storyforge composes them into domain queries.

### What this gives storyforge

- Does not build graph storage, traversal, or provenance tracking from scratch
- Gets schema validation for free
- Gets deterministic rebuild semantics from the compilation pipeline
- Provenance contract (every node traces to source artifacts) is enforced by the library
- Future: if memory-mcp integration is ever considered (see storyforge ADR 0011), the shared library is the natural bridge

### Python concern

Storyforge is Python. Options:

1. **TypeScript subprocess** — storyforge shells out to a CLI that the library exposes (`graph build`, `graph query`). Simple, no language binding needed. Latency per call, but graph compilation is a cold-path operation.
2. **JSON protocol** — library compiles graph to `compiled-graph.json`. Storyforge reads the JSON and implements its own query functions in Python over the compiled output. The library is the compiler; Python is the query runtime.
3. **Python port** — rewrite the core types and traversal in Python. Defeats the shared-library purpose unless both are maintained.

Option 2 is the most natural fit: the library compiles and validates; storyforge queries over the compiled JSON. This matches storyforge's existing `compiled-graph.json` design. The library becomes the compiler + validator; storyforge remains the query consumer.

## Consumer: etienne-clone (illustrative — will evolve)

### Schema

```typescript
type ReviewNodeType = 'principle' | 'pattern' | 'finding' | 'module' | 'developer';
type ReviewEdgeType = 'applies' | 'exemplified_by' | 'found_in' | 'corrected_about' | 'internalized';
```

### Compiler

Parses `events.jsonl` (review event history) + identity docs (philosophy, preferences) → review knowledge graph.

- Principles → `principle` nodes (from philosophy.md)
- Past findings → `finding` nodes (from events.jsonl)
- Modules mentioned in findings → `module` nodes
- Principle cited in a finding → `applies` edge
- Finding posted to a module → `found_in` edge
- Developer corrected about a principle multiple times → `corrected_about` edge
- Developer stops getting findings about a principle → `internalized` edge

### Query surface

```typescript
function getRelevantPrinciples(graph, filePaths: string[]): GraphNode<'principle'>[];
function getTeamPatterns(graph, moduleName: string): PatternBundle;
function getRepeatFindings(graph, developerId: string): GraphNode<'finding'>[];
```

### What this gives etienne-clone

Over time, the clone builds institutional knowledge:

- "This module has had 12 P08 (errors are data) findings — it is a hotspot"
- "This developer was corrected about !! usage twice — elevate from nitpick to major"
- "This pattern has been internalized team-wide — stop flagging it"

The review bot becomes smarter with every review, not just from the identity docs but from accumulated review history structured as a graph.

## Library design principles

### Derived, not authoritative

The graph is a compiled view over source artifacts. Source files remain the truth. If the graph disagrees with source, the graph is wrong. This principle is shared across all three consumers:

- memory-mcp: markdown entries are canonical, graph edges are derived
- storyforge: YAML/markdown artifacts are canonical, compiled graph is derived
- etienne-clone: events.jsonl and identity docs are canonical, review graph is derived

The library enforces this by requiring provenance on every node and edge. If you cannot trace it to a source, you cannot store it.

### Full rebuild first, incremental later

All three consumers start with full-rebuild compilation. The compiler reads source artifacts and produces the entire graph from scratch. Incremental mutation is a later optimization, not a v1 feature.

This keeps the first implementation:

- Simpler (no sync/drift concerns)
- More inspectable (rebuild from scratch, compare output)
- More trustworthy (no accumulated state drift)

### Schema validation at write time

The library validates that every node type and edge type conforms to the consumer's declared schema. An undeclared node type fails at write time, not at query time. This catches schema drift early and prevents the graph from becoming a junk drawer.

### Concurrency

Two options for the v1 storage backend:

1. **Single compiled file** (`compiled-graph.json`) — simple, inspectable, diffable. Single-writer assumption (one compiler runs at a time). Good for storyforge (cold-path compilation) and etienne-clone (batch compilation from events).
2. **Sidecar files** (one per node, one per edge) — concurrency-safe, matches memory-mcp's one-file-per-entry model. Good for memory-mcp where edges are created incrementally at store time.

The library should support both backends behind a storage interface. Each consumer picks the backend that matches their write pattern.

### Testing

- **`FakeGraph`** — in-memory graph for testing. No filesystem, no compilation. Consumers test their query surfaces against constructed graphs.
- **Schema validation** — test that undeclared node/edge types are rejected.
- **Provenance enforcement** — test that nodes/edges without provenance are rejected.
- **Deterministic compilation** — test that same source artifacts produce same graph (byte-for-byte).
- **Traversal primitives** — BFS, neighbors, filtered walks tested with known graph structures.

## Relationship to embeddings

Embeddings and the graph compose — they solve different problems:

| Capability | Embeddings | Graph |
|---|---|---|
| "Find things semantically similar to this query" | Yes — cosine similarity ranking | No — graph has no notion of "similar to free text" |
| "What is the typed relationship between these entries?" | No — similarity is untyped | Yes — `contradicts`, `supersedes`, `applies_to` carry meaning |
| "Find things related by transitive connections" | Weak — one-hop similarity only | Yes — multi-hop traversal follows typed edges |
| "Are these two entries in conflict?" | Partially — high similarity might mean agreement OR contradiction | Yes — `contradicts` edge is explicit |

The retrieval pipeline uses both layers:

1. **Embeddings** — broad semantic search to find candidate entries
2. **Graph** — structured enrichment to annotate candidates with relationship context

Neither layer replaces the other. Embeddings are the search engine; the graph is the relationship map.

## Implementation phasing

### Phase 0 — Core types and storage (shared library)

- `GraphNode<T>`, `GraphEdge<T>`, `SourceRef` types
- `GraphSchema` — consumer-declared node/edge type unions with validation
- `GraphStorage` interface — read/write/delete nodes and edges
- `FileGraphStorage` — compiled JSON file backend
- `SidecarGraphStorage` — one-file-per-item backend
- Provenance enforcement on write
- Basic traversal: neighbors, neighbors-by-type, BFS with depth limit

### Phase 1 — memory-mcp integration

- Define memory schema (`MemoryNodeType`, `MemoryEdgeType`)
- Edge auto-detection heuristics at store time (embedding similarity + keyword patterns)
- `enrichResults()` — annotate retrieval results with graph relationships
- Wire into `contextSearch` pipeline: after embedding+keyword ranking, enrich with graph
- Contradiction surfacing in `brief` and `recall` responses

### Phase 2 — storyforge integration

- Define story schema
- Story graph compiler: YAML + markdown → compiled graph
- Task-oriented query functions on top of traversal primitives
- CLI: `graph build`, `graph inspect`
- Context bundle assembly for roles

### Phase 3 — etienne-clone integration

- Define review schema
- Review graph compiler: events.jsonl + identity docs → review graph
- Query functions for principle relevance, team patterns, repeat findings

Phases 1-3 are independent. Each consumer can adopt the library on their own timeline. The library (Phase 0) must be stable before any consumer integrates.

## Open questions

### Where does the library live?

Separate repo (`typed-graph`? `knowledge-graph`?) or a package within an existing repo. Given three consumers across three repos, a separate repo with npm publishing makes the most sense.

### Edge auto-detection quality

Memory-mcp's edges are inferred from natural language. The heuristics will produce wrong edges. How wrong is acceptable? What is the correction mechanism? `fix` can delete entries, but there is no tool for deleting individual edges yet. Needs design.

### LLM-assisted edge classification

The MCP sampling capability could let the server ask the LLM to classify relationships. This is the most accurate approach but adds latency and cost. Should this be:

- Synchronous at store time (accurate but slow)?
- Background after store (fast response, edges appear later)?
- Batch during `reflect` / consolidation?

### Graph visualization

None of the three consumers currently need it. But a debug tool that renders the graph (even as ASCII or a simple HTML page) would be valuable for inspection. Deferred, but worth noting.

### Schema evolution

When a consumer adds a new node or edge type, existing compiled graphs need recompilation. The full-rebuild-first approach handles this naturally — recompile from source and the new types appear. But consumers need to be aware that schema changes trigger recompilation.
