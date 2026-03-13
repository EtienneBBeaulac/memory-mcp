# Memory MCP v2 — Design Briefing

## What this document is

A standalone briefing covering the full design thinking behind memory-mcp v2.
Start here if you are picking up this work. All decisions, their reasoning,
alternatives considered, and the implementation plan are covered.

Detailed designs are in companion docs (referenced throughout).
This doc tells you **why** and **what**; the companion docs tell you **how**.

---

## Context: the ecosystem

Etienne maintains several personal projects that share infrastructure:

- **memory-mcp** — MCP server for persistent agent memory across sessions. Stores
  knowledge (gotchas, conventions, architecture, preferences) as markdown files. Agents
  call tools to store and retrieve knowledge. The core product.
- **workspace-mcp** — MCP server for cross-project file access. Mostly redundant with
  built-in IDE tools (read_file, grep, edit all accept absolute paths). Only real
  differentiator is safety allowlists.
- **storyforge** — Multi-agent system for novel-length fiction. Uses a chapter cycle
  with AI roles (Story Architect, Author, Continuity Editor). Has a deferred local
  graph design for story entity relationships.
- **etienne-clone** — Etienne's code review bot for GitLab MRs. Embodies his philosophy,
  preferences, and voice. Uses WorkRail workflows to drive reviews.
- **workrail** — Workflow orchestration MCP server. Drives multi-step agent workflows.

## The starting question

"Is workspace-mcp useful?" — Answer: **no, not for Etienne's workflow.** Built-in tools
already handle cross-project file access via absolute paths. The only differentiator
(safety allowlists) is a nice-to-have since the user approves actions anyway.

Memory-mcp, by contrast, solves a problem built-in tools fundamentally cannot:
**persistent knowledge across sessions.** Every new chat starts as a blank slate.
Memory-mcp fixes that.

The conversation then focused entirely on making memory-mcp better.

---

## The three enhancements

Through extensive analysis and ideation, three independent enhancements emerged:

### 1. Semantic retrieval (embeddings)

**The problem**: Retrieval uses keyword extraction + naive stemming + Jaccard/containment
similarity. This fails on associative recall — the highest-value retrieval pattern.
Store "FlowCoordinator uses a state machine with side effects" and later query
"how do we handle async workflows in coordinators" → keyword overlap is near zero.
The entry is invisible.

**The solution**: Local embedding-based cosine similarity using Ollama (nomic-embed-text,
384-dim, ~10ms per embed). Sidecar `.vec` files alongside markdown entries. Semantic
ranking composed with keyword ranking — semantic-first, keyword tiebreaker. Graceful
degradation: if Ollama unavailable, keyword search works unchanged.

**Why this is the highest-priority enhancement**: It is the single biggest improvement
to retrieval quality. It enables everything downstream (tool surface and graph library
both benefit from embeddings). It is purely additive — zero breaking changes.

**Design doc**: `semantic-retrieval-design.md`
**Implementation plan**: `semantic-retrieval-implementation-plan.md`

### 2. New tool surface (dedicated tools)

**The problem**: The current 5 tools (`memory_context`, `memory_query`, `memory_store`,
`memory_correct`, `memory_bootstrap`) are database admin tools. `memory_store` alone
requires: topic, title, content, trust, references, tags, durabilityDecision — 7+
decisions competing with the agent's actual work. Agents are inconsistent about calling
them because the cognitive overhead is too high.

**The solution**: 9 dedicated tools + 1 MCP resource, where **the tool name carries the
metadata** that used to be parameters.

#### Retrieval tools
- **`brief(lobe)`** — Session start. Returns preferences, gotchas, recent work, stale entries.
- **`recall(lobe, context)`** — Semantic search across all categories.
- **`gotchas(lobe, area?)`** — Pitfalls before touching code. Scoped to area.
- **`conventions(lobe, area?)`** — Coding patterns before writing code. Scoped to area.

#### Storage tools
- **`gotcha(lobe, observation)`** — Flag a pitfall. Priority in every brief/recall.
- **`convention(lobe, observation)`** — Record a codebase pattern.
- **`learn(lobe, observation)`** — Store anything not covered by gotcha/convention.
- **`prefer(rule)`** — User preference. Global, no lobe. Surfaced in every brief.

#### Maintenance
- **`fix(id, correction?)`** — Correct or delete. No lobe (resolved from ID).

#### Resource
- **`memory://lobes`** — Dynamic JSON listing available projects. Some hosts auto-inject.

#### Key design decisions

**Singular stores, plural retrieves**: `gotcha` → `gotchas`, `convention` → `conventions`.
Natural English. The agent thinks "I found a gotcha" → `gotcha(...)`.
"Are there gotchas here?" → `gotchas(...)`.

**Lobe is required, not auto-detected**: Auto-detection from MCP workspace roots is
unreliable across IDE implementations. Agents ignore hints in successful responses but
reliably retry on errors. Missing lobe → hard error listing available lobes. No silent
wrong-repo behavior.

**"Returns related knowledge" on every store** (the "loot drop"): Every storage tool
returns related entries as part of the response. The agent gets immediate value back —
not storing "for the future" but getting useful context right now as a side effect.

**No internal concepts leak**: No mention of topics, trust levels, tags, scopes, filter
syntax, or any internal concept in tool descriptions. The agent never learns about the
memory system's internals.

**Design doc**: `v2-tool-surface-and-retrieval.md`

### 3. Typed graph library (shared infrastructure)

**The problem**: Embeddings find "semantically similar" entries but cannot express
typed relationships. "These two entries are similar" is different from "these two
entries contradict each other." At scale, across multiple projects, typed relationships
carry information that cosine similarity cannot.

**The solution**: A shared, domain-agnostic typed graph library providing storage,
traversal, schema validation, provenance tracking, and compilation primitives. Three
consumers, each bringing their own schema:

- **memory-mcp** — `supersedes`, `contradicts`, `applies_to`, `depends_on`, `exemplifies`
  edges between knowledge entries. Edge auto-detection using embedding similarity +
  heuristics at store time.
- **storyforge** — `appears_in`, `introduced_in`, `resolved_in`, `constrains`, `affects`
  edges between story entities (characters, promises, locations). Deterministic compilation
  from YAML/markdown. This replaces storyforge's planned local graph slice with a shared
  library.
- **etienne-clone** — `applies`, `exemplified_by`, `found_in`, `corrected_about` edges
  between review findings, principles, modules, and developers. Builds institutional
  knowledge over time.

**Why a shared library changes the economics**: A graph for memory-mcp alone was dismissed
because embeddings cover the retrieval need at ~200 entries. But as a shared library,
implementation cost is amortized across 3 consumers, and each consumer independently
validates the abstraction. Storyforge doesn't build from scratch; etienne-clone gets
review knowledge for free.

**Embeddings and graph compose, not compete**: Embeddings are the search engine (find
candidates by semantic similarity). The graph is the relationship map (annotate candidates
with typed context: contradictions, dependencies, superseded entries).

**Design doc**: `graph-library-design.md`

---

## How we got here (the ideation arc)

The design didn't start with "build embeddings and a graph." Here is the reasoning
path that led to these three enhancements.

### Phase 1: What's genuinely useful?

Started by listing what an MCP server CAN and CANNOT do. Key capabilities: persistent
state across tool calls, background processing, tool descriptions as behavioral nudges,
rich responses as reward, sampling (server-initiated LLM calls). Key limitations: cannot
see the conversation, cannot force tool calls, no lifecycle hooks.

The single most important enhancement identified: **semantic retrieval**. The text-analyzer
header (lines 5-7) already anticipated this: v1 keywords, v2 knowledge graph,
v3 embeddings. Embeddings are the unlock because they improve every retrieval path.

### Phase 2: Can we reduce agent friction?

The core problem: agents are inconsistent about calling memory tools because the tools
require too many decisions. We ran 6 parallel ideation routines with different lenses
(UX designer, cognitive scientist, extreme minimalist, devil's advocate, systems
architect, game designer).

Key themes that emerged across perspectives:
- **"Kill the form"** — collapse storage to one free-text param, server does the thinking
- **"Episodic first, consolidate later"** — cheap capture now, structure offline
- **"Retrieval IS the reward"** — every tool call returns unexpected value (the "loot drop")
- **"Context is the query"** — workspace state drives retrieval, not composed queries
- **"Remember only surprises"** — filter ruthlessly at write time
- **"The adversary"** — memory that challenges assumptions, not just serves
- **"The unfinished map"** — visible gaps create intrinsic motivation

### Phase 3: Friction vs usefulness tradeoff

Critical realization: **the lowest-friction ideas produce the lowest-quality knowledge,
and the highest-quality ideas have the highest friction.** `note(text)` is frictionless
but stores whatever the agent blurts out. `surprise(expected, actual, reason)` has more
friction but forces precision.

The winning design **layers** these: cheap capture (low friction) + smart retrieval
(embeddings handle quality at read time) + dedicated tools where the name carries the
category (moderate friction but the structure is the filter).

### Phase 4: Retrieval-first reframe

Insight: stop trying to solve "how to get agents to store the right things" and instead
solve "how to surface the right things from whatever was stored." Quality is a
retrieval-time concern, not a storage-time concern. This is the argument for investing
in embeddings over storage-time filtering.

But at ~200 entries, "Google for memory" is just cosine similarity over vectors. Which is
the semantic retrieval design we already had. **We went around the block and came back to
embeddings as the unlock.**

### Phase 5: Dedicated tools

Instead of collapsing to fewer tools, split into MORE tools where each name is
self-evident. Agents handle many tools fine (read_file, grep, edit, etc. — 9+ tools used
flawlessly). They struggle with *confusing* tools, not many tools.

The mirrored pattern emerged: singular stores (`gotcha`), plural retrieves (`gotchas`).
Lobe required, not auto-detected. Resource for available lobes.

### Phase 6: Graph library

Initially dismissed graphs for memory-mcp ("embeddings cover the retrieval need at 200
entries"). Reconsidered when framed as a **shared library** consumed by memory-mcp,
storyforge, and etienne-clone. The economics flip: implementation cost amortized, each
consumer validates independently, storyforge doesn't reinvent.

---

## Priority order

```
1. Embeddings        — highest value, lowest risk, enables everything downstream
2. Tool surface      — reduces friction, better descriptions, ships with or without embeddings
3. Graph library     — highest long-term value, highest complexity, new repo
```

Each ships independently. Embeddings improve existing tools. New tools work without
embeddings (keyword fallback). Graph enriches embedding results but isn't required.

---

## Implementation plan summary

### Embeddings (10 steps, 4 PRs)

Full plan in `semantic-retrieval-implementation-plan.md`. Summary:

**PR 1 — Infrastructure** (no behavior change):
- `embedder.ts` — `Embedder` interface, `EmbedResult` discriminated union, `OllamaEmbedder`, `FakeEmbedder`
- `cosineSimilarity` in `text-analyzer.ts` — pure function
- Sidecar `.vec` read/write/delete in `store.ts` — one per entry, 4-byte dimension header

**PR 2 — Extract keywordRank** (pure refactor, regression test):
- Extract inline keyword matching from `contextSearch` into pure `keywordRank()` function
- New `ScoredEntry` and `RankContext` types
- Regression gate: identical results with `embedder: null`

**PR 3 — Semantic retrieval** (the feature):
- `semanticRank()` and `mergeRankings()` pure functions
- Wire embedder into `store()` and `correct()` write paths (awaited, not fire-and-forget)
- Rewrite `contextSearch` as orchestrator composing the ranking functions
- 1s query-time timeout on embed calls (separate from 5s store-time timeout)

**PR 4 — Polish**:
- `EmbedderConfig` in types + config parsing
- `LazyEmbedder` for auto-detect (lazy probe on first use, not startup)
- `reEmbed()` migration tool + `memory_reembed` hidden tool
- Mode indicator in responses: "Search: semantic + keyword (47/52 entries vectorized)"

### Tool surface (Phase 2 in `v2-tool-surface-and-retrieval.md`)

1. Add `memory://lobes` resource
2. Implement 4 retrieval tools as wrappers over existing internals
3. Implement 4 storage tools with auto-title extraction and loot drops
4. Implement `fix` with presence/absence semantics
5. Remove old tools entirely (single user, clean cut)

### Graph library (Phase 5, separate repo)

1. Core types and storage (Phase 0 — shared library)
2. Memory-mcp integration (schema, edge auto-detection, result enrichment)
3. Storyforge integration (story schema, compiler, context bundles)
4. Etienne-clone integration (review schema, compiler, pattern detection)

---

## Key design principles applied throughout

These are from Etienne's coding philosophy. Every design decision was justified against them.

- **[P08] Errors are data** — `EmbedResult` discriminated union, never exceptions
- **[P21] Graceful degradation** — Full → Partial → Keyword-only. Never crashes.
- **[P13] Compose with small, pure functions** — ranking pipeline: `keywordRank`, `semanticRank`, `mergeRankings`, each independently testable
- **[P17] DI for boundaries** — `Embedder` interface injected into store, `FakeEmbedder` for tests
- **[P11] Determinism** — pure functions, named threshold constants, no magic numbers in function bodies
- **[P09] Validate at boundaries** — dimension header checked on vector load, text validated before embedding
- **[P20] Prefer atomicity** — embed awaited in store(), not fire-and-forget (prevents race condition)
- **[P25] Small interfaces** — `Embedder` has one method + one property. Batch is a utility.
- **[P19] YAGNI** — graph library deferred until embeddings are proven. `findRelatedEntries` stays keyword-based for now.
- **[P23] Observability** — `ScoredEntry.source` field, mode indicator in responses, stderr logging for embed failures

---

## Companion docs

| Document | Content |
|---|---|
| `semantic-retrieval-design.md` | Embedding architecture: types, storage, ranking pipeline, degradation, testing |
| `semantic-retrieval-implementation-plan.md` | Step-by-step build plan for embeddings (10 steps, 4 PRs, philosophy-justified) |
| `v2-tool-surface-and-retrieval.md` | Tool surface redesign: 9 tools + 1 resource, descriptions, isolation, phasing |
| `graph-library-design.md` | Shared typed graph library: 3 consumers, schemas, composition with embeddings |

---

## Review feedback incorporated

The implementation plan was reviewed and five corrections were accepted:

1. **Title doubling removed from embed text** — `"${title} ${title} ${content}"` biased
   the embedding toward title keywords, working against associative recall. Changed to
   `"${title}. ${content}"` — title as leading sentence, weighting at scoring time.

2. **Zero-keyword early return is conditional** — `contextSearch` no longer bails on zero
   keywords when embedder is available. Stopword-heavy queries (`"how things work together"`)
   produce zero keywords but can still yield useful semantic results.

3. **Semantic dedup moved into Phase 1** — reduced storage friction + more entries = more
   duplicates. Since we embed at store time, checking cosine similarity against existing
   vectors is nearly free. Now in Step 6 scope, not deferred.

4. **`LazyEmbedder` retries after 5-minute TTL** — previously permanently disabled after
   one failed probe. Now re-probes after 5 minutes so the system recovers if Ollama starts
   after MCP startup.

5. **Debug score logging added** — `SEMANTIC_MIN_SIMILARITY = 0.30` is a conservative
   guess. Debug-level logging of all semantic scores (Step 10) enables calibration from
   real queries. The threshold is easy to tune but needs real data.

Additional notes from review (not yet actioned — watch items):

- `FakeEmbedder` trigrams test pipeline mechanics, not semantic quality. Integration tests
  with real Ollama needed (skipped in CI).
- `learn` redirect hints may be annoying. Track whether agents follow them.
- Graph library consumer schemas (storyforge, etienne-clone) are illustrative, not locked.
  Will evolve after embeddings are proven.
- Edge auto-detection needs a correction mechanism for individual edges (not just entries).
- Cross-repo factual knowledge (`"backend returns UTC dates"`) needs a better model than
  `prefer`. A `shared` lobe or multi-lobe tagging is more honest.

### Second review feedback incorporated

Additional corrections from a second review pass:

- **`learn` auto-categorization deferred to Phase 4** — keyword heuristics are fragile 
  ("we avoid using mocks" triggers gotcha redirect). With semantic retrieval, topic 
  categorization is low-stakes. `learn` stores to `general` topic by default 
  (see third review below for why not `architecture`).
- **Debug score logging moved to PR3 (Step 5)** — score distributions needed from day one, 
  not after a separate polish PR.
- **Query-time embed timeout bumped from 1s** — see third review for final timeout design.
- **Graph library doc framed as vision document** — consumer schemas are illustrative 
  sketches, not commitments. See third review for further downgrade to "parking lot."
- **Cross-repo knowledge** — see third review for updated status (reverted to open question).
- **Error messages include `memory_bootstrap` hint** — new users who call `brief("android")` 
  with no lobes configured get pointed to the right entry point.
- **Model name hash in `.vec` header** — noted as YAGNI future consideration for multi-model 
  support. Dimension check sufficient for now.

### Third review feedback incorporated

- **Shared lobe reverted to open question** — the interaction model was under-designed. 
  Ranking relative to lobe-specific results, scoping (not all shared facts apply to all 
  lobes), and noise accumulation were unresolved. Cross-repo facts are rare enough that 
  manual duplication across relevant lobes is acceptable friction for now.
- **`learn` defaults to `general` topic, not `architecture`** — polluting a meaningful 
  category with catch-all entries is worse than an explicit junk drawer. `general` makes 
  the catch-all nature visible.
- **Graph library downgraded from "Phase 5" to "parking lot"** — no consumers exist as 
  graph consumers. YAGNI. Revisit after 3-6 months of real usage only if retrieval quality 
  plateaus.
- **`SEMANTIC_MIN_SIMILARITY` raised from 0.30 to 0.45** — nomic-embed-text produces 0.2-0.4 
  for unrelated text pairs. Starting strict and loosening with data is safer than starting 
  loose and causing regressions when tightening later.
- **FakeEmbedder limitation elevated to action** — trigram vectors test pipeline mechanics 
  but not semantic ordering. Added real `nomic-embed-text` fixture vectors for ranking 
  regression tests.
- **Cold model timeout: first query 5s, subsequent 2s** — Ollama can evict models under 
  memory pressure; first real query may need cold load time. Timeout counter tracked in 
  mode indicator.
- **Embed text separator changed to `\n\n`** — paragraph separator produces better 
  embeddings than period separator (model trained on paragraph-separated text). Many titles 
  are sentence fragments without verbs, making period-separated text read unnaturally.
- **Orphan `.vec` cleanup during `loadVectorSnapshot`** — prevents slow accumulation of 
  dead files from entries deleted while embedder was unavailable.
- **`text-analyzer.ts` version header** — should be updated to reflect actual evolution 
  path: v1 keywords → v2 embeddings → v3 graph-enriched. The existing "v2: spreading 
  activation" is incorrect; the graph library is typed edge traversal, not spreading 
  activation.

### Fourth review feedback incorporated

- **`.vec` format version byte** — added `0x01` at byte 0. Costs 1 byte per file, 
  future-proofs the format for adding metadata (model hash, float16, etc.) without 
  ambiguity. v2 format changes are non-breaking.
- **Timeout bump-back for re-eviction** — after 3 consecutive timeouts, temporarily bump 
  back to 5s for one attempt. Handles mid-session Ollama model eviction without waiting 
  for the LazyEmbedder 5-min reprobe cycle.
- **`contextSearch` return type change** — elevated from buried note to explicit sub-step 
  with caller checklist. `index.ts` has multiple call sites that need updating.
- **Lobe-specific threshold baseline** — domain-adjacent text (same codebase entries) has 
  higher baseline similarity than random text. 0.45 may need lobe-specific adjustment. 
  Debug logging will reveal this.
- **`prefer` lobe-affinity** — optional `lobe` param added to schema now (not filtered yet). 
  Prevents migration later when preference noise becomes a problem at 30+ entries. 
  `prefer("use Anvil for DI", "android")` surfaces only in that lobe's brief.
- **`general` topic ratio tracking** — added to Phase 4 evaluation: if `general` exceeds 
  40% of entries, agents are defaulting to `learn` and nudges are needed.

---

## Open questions

1. **Graph library repo location** — separate repo or package within an existing repo?
   Given 3 consumers across 3 repos, separate repo with npm publishing makes sense.
   TypeScript — all consumers are TypeScript (storyforge is Python but consumes
   compiled JSON output).

2. **Edge auto-detection quality for memory-mcp** — edges are inferred from natural
   language, not structured YAML. Heuristics will produce wrong edges. How wrong is
   acceptable? What is the correction mechanism? Currently no tool for deleting
   individual edges.

3. **LLM-assisted edge classification** — MCP sampling capability could let the server
   ask the LLM to classify relationships. Synchronous at store time (accurate but slow)
   vs background (fast, edges appear later) vs batch during consolidation.

4. ~~**Tool surface migration strategy**~~ — Resolved: single user, no migration needed.
   Old tools (`memory_context`, `memory_query`, `memory_store`, `memory_correct`) are
   deleted outright and replaced by the new 9-tool surface.

5. **Cross-repo knowledge** — Still open. A `shared` lobe was proposed and reverted — the 
   ranking interaction (how shared results interleave with lobe-specific), scoping (not all 
   shared facts apply to all lobes), and noise accumulation are unresolved. Manual 
   duplication across relevant lobes is the stopgap. Options to explore when demand arises: 
   tagging mechanism, lobe-affinity tags, or a `shared` lobe with per-entry lobe scoping.

6. **Semantic threshold calibration** — `SEMANTIC_MIN_SIMILARITY = 0.45` (raised from 0.30). 
   `DEDUP_SEMANTIC_THRESHOLD` (TBD) also needs calibration. Debug score logging ships with 
   PR3 (Step 5) for immediate data collection. Starting strict and loosening is safer than 
   starting loose.
