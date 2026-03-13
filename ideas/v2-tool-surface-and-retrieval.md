# Memory MCP v2 — Tool Surface Redesign + Semantic Retrieval

## Overview

Two independent enhancements:
1. **Semantic retrieval** — embedding-based search (the engine)
2. **New tool surface** — 9 dedicated tools + 1 resource (the interface)

Either ships independently. Embeddings improve the existing tools. New tools work without embeddings (keyword fallback). Together they are the full vision.

## Design Thinking Summary

### The problem with the current tools

The current 5 tools (`memory_context`, `memory_query`, `memory_store`, `memory_correct`, `memory_bootstrap`) are memory-management tools. They ask the agent to think like a librarian — which topic? what trust level? what tags? — when the agent is trying to think like an engineer.

`memory_store` alone requires: topic, title, content, trust, references, tags, durabilityDecision. That is 7+ decisions competing with the agent's primary work.

### Key insight: retrieval-first, not storage-first

The quality problem is better solved at retrieval time than storage time. Semantic embeddings rank stored knowledge by relevance — low-signal entries naturally sink, high-signal entries surface. This means storage can be low-friction without sacrificing retrieval quality. The system works like search engines: accept noisy input, deliver ranked output.

### Key insight: tool names carry the metadata

Instead of one complex multi-purpose tool with a `topic` parameter, use dedicated tools where the tool name IS the category. The agent does not pick from a dropdown; it reaches for the right tool by name. `gotcha("...")` instead of `memory_store(topic: "gotchas", title: "...", content: "...", trust: "agent-inferred")`.

### Key insight: fail fast on lobe resolution

Auto-detection of the current repo (from MCP workspace roots) is unreliable across IDE implementations. Agents ignore hints in successful responses. Making lobe a required parameter means the tool fails hard if omitted — and agents reliably retry on errors. An MCP resource exposes available lobes so the agent knows what to pass.

---

## Part 1: Semantic Retrieval

Full design in `semantic-retrieval-design.md`. Summary below.

### Architecture

- **`Embedder` interface** — minimal: `embed(text, signal?) → EmbedResult` + `dimensions`. Injected into store. `EmbedResult` is a discriminated union (errors are data). `AbortSignal` for timeouts.
- **`OllamaEmbedder`** — local, `nomic-embed-text` (384-dim, ~10ms/embed, 137MB model). No cloud dependency.
- **`FakeEmbedder`** — deterministic, hash-based. For testing the full pipeline without Ollama.
- **`batchEmbed(embedder, texts)`** — standalone utility function. Not on the interface (interface segregation).
- **Sidecar `.vec` files** — one per entry alongside the markdown. 4-byte dimension header for model migration detection. Embeddings are a cache — delete all `.vec` files and the system degrades to keyword search.
- **Cosine similarity** in `text-analyzer.ts` — pure function, ~1ms for 200 entries.

### Ranking pipeline

Three pure composable functions, independently testable:

- `keywordRank(entries, contextKeywords, ...)` — existing `contextSearch` logic extracted
- `semanticRank(entries, vectors, queryVector, ...)` — cosine similarity scoring
- `mergeRankings(semantic, keyword)` — semantic-first, keyword tiebreaker. No magic weight constants.

### Degradation ladder

| State | Embedder | Behavior |
|---|---|---|
| **Full** | Available, all entries have vectors | Semantic + keyword merge |
| **Partial** | Available, some entries lack vectors | Semantic for vectorized entries, keyword for rest, merged |
| **Keyword-only** | Unavailable (Ollama down/not installed) | Existing behavior, zero regression |

### Configuration

```json
{
  "lobes": { "...": "..." },
  "embedder": {
    "provider": "ollama",
    "model": "nomic-embed-text"
  }
}
```

Auto-detect when `embedder` config absent: probe Ollama at startup, enable if available, log and continue if not. `provider: "none"` for explicit opt-out.

### Migration

`reEmbed()` — re-embeds all entries missing or outdated vectors. Idempotent. Exposed as hidden tool `memory_reembed`. Not triggered on hot path.

### Implementation order

1. `embedder.ts` — interface, `OllamaEmbedder`, `FakeEmbedder`, `batchEmbed` utility
2. `cosineSimilarity` in `text-analyzer.ts`
3. Sidecar `.vec` read/write/delete in `store.ts`
4. Extract `keywordRank` from existing `contextSearch` (pure refactor, no behavior change)
5. Add `semanticRank` and `mergeRankings`
6. Wire embedder into `store()` write path
7. Wire ranking pipeline into `contextSearch()`
8. `EmbedderConfig` in types/config, auto-detect at startup
9. `reEmbed()` + `memory_reembed` hidden tool
10. Mode indicator in responses

---

## Part 2: New Tool Surface

9 tools + 1 resource, replacing the current 5 tools.

### Resource: `memory://lobes`

Dynamic JSON listing available projects. Read from `configManager`, updates on hot-reload. Some hosts auto-inject resources into agent context.

```json
{
  "lobes": [
    { "name": "android", "project": "Android (ZillowMap)", "root": "~/git/zillow/ZillowMap" },
    { "name": "ios", "project": "iOS (ZillowMap)", "root": "~/git/zillow/ZillowMap-ios" },
    { "name": "workrail", "project": "Workrail MCP", "root": "~/git/personal/workrail" }
  ]
}
```

Tool descriptions reference this resource. Missing lobe errors list available lobes.

### Tool catalog

```
brief(lobe)                 — Session start for a project
recall(lobe, context)       — Search knowledge by relevance
gotchas(lobe, area?)        — Check for pitfalls before making changes
conventions(lobe, area?)    — Check coding patterns before writing code
gotcha(lobe, observation)   — Flag a pitfall you hit
convention(lobe, observation) — Record a codebase pattern
learn(lobe, observation)    — Store any other knowledge
prefer(rule, lobe?)         — Record a user preference (global by default, optionally scoped)
fix(id, correction?)        — Correct or delete an entry (no lobe, resolved from ID)
```

Store one (singular) → retrieve many (plural). Natural English. The mirrored pairs:

```
gotcha → gotchas
convention → conventions
learn → recall (general semantic search)
prefer → brief (preferences always surface in briefing)
```

### Tool descriptions

#### Retrieval

**`brief(lobe)`**
```
Session start for a project. Returns preferences (global), gotchas, and recent
work for this project and branch. Also surfaces stale entries that need review.
Lobe names are in the memory://lobes resource. Example: brief("android")
```

**`recall(lobe, context)`**
```
Search stored knowledge by relevance within a project. Describe your task or
question in natural language. Example: recall("android", "how does auth token
refresh work") or recall("android", "refactoring the payment webhook handler")
```

**`gotchas(lobe, area?)`**
```
Pitfalls in a project, optionally scoped to an area. Check before making
changes. Example: gotchas("android", "auth") or gotchas("android")
```

**`conventions(lobe, area?)`**
```
Coding patterns in a project, optionally scoped. Check before writing new code.
Example: conventions("ios", "testing") or conventions("ios")
```

#### Storage

**`gotcha(lobe, observation)`**
```
Flag a pitfall you hit — what you expected vs what actually happened. Gets
priority in brief and recall. Returns related knowledge. Example:
gotcha("android", "Gradle cache must be cleaned after Tuist changes or builds
silently use stale artifacts")
```

**`convention(lobe, observation)`**
```
Record a codebase pattern you observed. For personal rules, use prefer instead.
Returns related knowledge. Example: convention("ios", "Coordinators own their
child view controllers, never the reverse")
```

**`learn(lobe, observation)`**
```
Store architecture, dependencies, decisions, progress, or any knowledge not
covered by gotcha or convention. Returns related knowledge. Example:
learn("android", "Payments module depends on auth for tokens only")
```

**`prefer(rule, lobe?)`**
```
When your user corrects you or states a rule, record it here. Persists globally by
default, surfaced in every brief. Optionally scope to a specific project.
Example: prefer("Never use !! operator") or prefer("Use Anvil for DI", "android")
```

**Lobe-affinity design**: `lobe` is optional. When absent, the preference is global 
(surfaces in every brief). When present, the preference surfaces only in that lobe's 
brief. The schema stores `lobe?: string` on the entry now even if filtering isn't 
implemented in Phase 2 — avoids a migration later when preference noise becomes a problem.

At scale (30+ preferences), unscoped preferences create a wall of text in every brief. 
Some preferences are truly universal ("never use !!"), others are project-specific ("use 
Anvil for DI") but stored globally because the agent doesn't know the distinction. The 
optional lobe param lets the agent express that distinction when it's obvious.

#### Maintenance

**`fix(id, correction?)`**
```
Correct or delete a memory entry. IDs appear in brief, recall, gotchas, and
conventions results. Pass correction to update; omit to delete. Example:
fix("gotcha-a1b2c3d4", "Fixed in v2.3") or fix("gotcha-a1b2c3d4")
```

### Description design principles

- Every storage tool says "returns related knowledge" — the loot-drop motivation
- `gotcha` nudges toward "expected vs actual" — improves quality without a structured format
- `convention` redirects to `prefer` for personal rules — positive routing, not scolding
- `learn` leads with what it IS, then redirects to gotcha/convention for those — catch-all by exclusion
- `prefer` names the trigger moment: "when your user corrects you"
- `fix` says where IDs come from — closes the loop
- No mention of topics, trust levels, tags, scopes, filter syntax, or any internal concept

### Isolation model

```
Reads:   brief, recall    → current lobe + global (preferences always surface)
         gotchas           → current lobe only
         conventions       → current lobe only

Writes:  gotcha, convention, learn → current lobe
         prefer                     → global (always)
         fix                        → wherever the entry lives (resolved from ID)
```

Lobe is required on 7 tools. Missing lobe → hard error with available lobes listed. No silent wrong-repo behavior. `prefer` and `fix` do not need lobe.

**Error messages**:
- Missing lobe param: `"Error: lobe is required. Available lobes: android, ios, workrail. See memory://lobes resource."`
- Unknown lobe name: `"Error: unknown lobe 'andriod'. Available lobes: android, ios, workrail. See memory://lobes resource."`
- No lobes configured: `"Error: no lobes configured. Run memory_bootstrap to set up your first project."`

The last case is important for new users — `memory_bootstrap` is the entry point, and the error should point to it explicitly.

### Cross-repo knowledge (deferred — open question)

`prefer` is for user preferences (global, personal rules). Factual cross-repo knowledge — 
"the backend API returns dates in UTC without timezone markers" — is NOT a preference. It's 
a shared observation relevant to multiple lobes.

**Previously proposed:** A `shared` lobe with auto-inclusion in `recall`/`brief`. 

**Deferred because the design is under-specified:** How are shared results ranked relative 
to lobe-specific results? Penalized? Boosted? Interleaved? Shared entries accumulate facts 
relevant to some lobes but not others — "backend returns UTC dates" matters to android and 
ios but not workrail. Without scoping, shared becomes noise.

Options to explore when real usage creates demand:
- **Tagging mechanism** — shared entries declare which lobes they apply to
- **Manual duplication** — store in both relevant lobes (acceptable friction for rare cases)
- **`shared` lobe with lobe-affinity tags** — auto-included only in matching lobes

For now, cross-repo facts are rare enough that manually storing in each relevant lobe is 
acceptable. This is explicitly a gap, not a resolution.

### Internal mapping

| New tool | Maps to internally |
|---|---|
| `brief(lobe)` | `briefing()` on lobe store + global store merge |
| `recall(lobe, context)` | `contextSearch(context)` on lobe + global, with embeddings |
| `gotchas(lobe, area?)` | `query(scope: "gotchas", filter: area)` on lobe |
| `conventions(lobe, area?)` | `query(scope: "conventions", filter: area)` on lobe |
| `gotcha(lobe, obs)` | `store(topic: "gotchas", ...)` + auto-title + embed + related entries |
| `convention(lobe, obs)` | `store(topic: "conventions", ...)` + auto-title + embed + related entries |
| `learn(lobe, obs)` | `store(topic: "general")` + auto-title + embed + related entries |
| `prefer(rule, lobe?)` | `store(topic: "preferences", trust: "user")` in global store, with optional `lobe` affinity on entry |
| `fix(id, correction?)` | `correct(id, correction, action)` — presence/absence determines update vs delete |

### Auto-categorization for `learn`

**Deferred to Phase 4.** `learn` stores to a dedicated `general` topic by default.

Using `architecture` as the default was rejected — it pollutes a meaningful category with 
catch-all entries. A dedicated `general` topic makes the catch-all nature explicit rather 
than diluting a real organizational category. At scale, `general` can be reviewed and 
re-categorized; mixed-in architecture entries cannot be easily separated.

The original plan had keyword-based heuristics to redirect agents toward `gotcha`/`convention`. 
Review feedback identified that these heuristics are fragile — e.g., "we avoid using mocks" 
contains "avoid" and would trigger a gotcha redirect despite being a convention. False positive 
redirects would suppress `learn` usage, which is worse than storing in the wrong topic.

With semantic retrieval, topic categorization is low-stakes — embeddings find entries regardless 
of which topic they're filed under. Topics are organizational metadata for human inspection, 
not retrieval-critical routing.

Phase 4 will evaluate whether heuristics are needed at all, based on actual usage data. If 
agents naturally use `gotcha`/`convention` for high-signal observations, `learn` auto-categorization 
adds no value.

---

## What stays the same internally

- **Markdown storage** — one file per entry, `.git/memory/` structure unchanged
- **`MarkdownMemoryStore`** — core CRUD, dedup detection, conflict detection, staleness
- **Ephemeral detection** — write-time noise filter
- **Topic system** — internal organization, hidden from agent-facing surface
- **Trust levels** — exist internally, not exposed as parameters (`gotcha`/`convention`/`learn` default to agent-inferred, `prefer` defaults to user-trust)
- **Config system** — `memory-config.json`, hot-reload, lobe resolution
- **Crash journaling** — resilience features unchanged
- **Global store** — `~/.memory-mcp/global/` for user + preferences
- **Branch-scoped recent-work** — unchanged, auto-detected from git

## What gets deleted

Old tools are removed entirely (single user, no migration needed):

- `memory_context` — deleted, replaced by `brief` + `recall`
- `memory_query` — deleted, replaced by `recall` + `gotchas` + `conventions`
- `memory_store` — deleted, replaced by `gotcha` + `convention` + `learn` + `prefer`
- `memory_correct` — deleted, replaced by `fix`
- `memory_bootstrap` — kept as hidden utility tool (first-use setup)
- Removed parameters: `topic`, `trust`, `tags`, `references`, `durabilityDecision`, `detail`, `scope`, `filter` syntax, `branch` — all gone
- Hidden tools: `memory_bootstrap`, `memory_stats`, `memory_diagnose`, `memory_reembed` (new)

---

## Implementation plan

### Phase 1 — Semantic retrieval (no tool surface change)

Steps 1-10 from the semantic retrieval design. Ship behind existing tools. Regression test: identical results with `embedder: null`.

**Dependency:** Ollama installed with `nomic-embed-text` model for production use. `FakeEmbedder` for tests.

### Phase 2 — New tool surface (with or without embeddings)

1. Add `memory://lobes` resource to MCP server
2. Implement 4 retrieval tools as wrappers over existing `contextSearch`/`query`/`briefing`
3. Implement 4 storage tools as wrappers over existing `store` with auto-title extraction
4. Implement `fix` as wrapper over `correct` with presence/absence semantics
5. Add "returns related knowledge" (loot drop) to all storage tool responses
6. Delete old tools (`memory_context`, `memory_query`, `memory_store`, `memory_correct`)
7. Update README and tool descriptions

### Phase 3 — Polish

- Mode indicator in responses ("search: semantic + keyword, 47/52 entries vectorized")
- Stale entry formatting in `brief` response
- `reEmbed` hidden tool for vector migration
- Update existing tests, add new tests for tool wrappers

### Phase 4 — Evaluate and iterate

- Monitor agent usage patterns: which tools get called, which get ignored
- Check storage quality: are gotcha/convention entries higher-signal than learn?
- Check retrieval quality: does semantic search surface better results than keyword?
- Tune: adjust topic boost weights, embedding merge strategy
- **Track `general` topic ratio** — if `general` exceeds 40% of total entries after a few 
  weeks of usage, that's a signal agents default to `learn` for everything and you need 
  either auto-categorization or a stronger nudge in the `learn` description toward 
  `gotcha`/`convention`
- Decide: do `learn` entries need auto-categorization heuristics, or do agents naturally 
  use the right tool? Only add heuristics if data shows `learn` is a junk drawer
- Decide: would `learn` redirect hints be helpful or annoying? Measure before investing
- **Monitor `prefer` noise** — if 30+ preferences accumulate and brief responses become 
  walls of text, implement lobe-affinity filtering (schema already supports it)

### Parking lot — Typed graph library

**Not a phase. No timeline.** Full vision in `graph-library-design.md`.

A shared typed graph library could provide storage, traversal, schema validation, and 
provenance primitives. memory-mcp would be one of three consumers (alongside storyforge 
and etienne-clone), each bringing their own schema and compiler.

**When to revisit:** After 3-6 months of real usage with embeddings + new tool surface. 
Only if retrieval quality plateaus and there's evidence that typed relationships 
(`contradicts`, `supersedes`) would produce meaningfully better results than "here are 
the 5 most similar entries." No consumers exist as graph consumers yet — building shared 
infrastructure for unproven requirements violates YAGNI.

The graph library design doc is preserved as a vision document, not a commitment.
