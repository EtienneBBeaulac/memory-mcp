# Memory MCP Roadmap

## Current State (v0.1.1)

Flat topic-based store with one-file-per-entry. 12 tools + 3 MCP resources, 332 tests.
Shared across worktrees via `.git/memory/`, branch-scoped recent-work.
Topics: user, preferences, architecture, conventions, gotchas, recent-work, modules/*.
Dedup via hybrid Jaccard+containment with naive stemming. Preference surfacing
on store. `memory_context` for keyword-based contextual search with topic boosting.
Piggyback hints on correct/store responses.

### Recent additions (this session)
- **`references` field**: optional file/class paths on entries, persisted to disk,
  1.3x context search boost when reference basename matches context keywords.
- **Tiered staleness**: user=always fresh, preferences=90 days, everything else=30 days.
  Trust level no longer exempts from staleness. Briefing surfaces top 5 stale entries
  with structured `StaleEntry` data and actionable `memory_correct` instructions.
- **Conflict detection**: cross-topic similarity check (>60%) on query/context results.
  Surfaces top 2 conflict pairs with consolidation guidance.
- **MCP Resources**: `memory://lobes`, `memory://stats`, `memory://diagnostics`.
  Old tools (`memory_list_lobes`, `memory_stats`, `memory_diagnose`) kept as
  deprecated aliases. Shared builder functions (`buildLobeInfo`, `buildDiagnosticsText`).
- **`src/thresholds.ts`**: central named constants for all magic numbers. Internal
  algorithm thresholds (dedup, conflict, boost) separate from user-facing behavior
  defaults (stale days, max stale in briefing, max dedup/conflict caps).
- **`BehaviorConfig`**: user-configurable via `memory-config.json` `"behavior"` block.
  `parseBehaviorConfig()` validates ranges, warns on unknown keys (typo detection).
  Active config surfaced in `memory_diagnose` / `memory://diagnostics`.
- **Ephemeral content detection**: declarative signal registry in `src/ephemeral.ts`.
  13 regex signals: temporal, fixed-bug, task-language, stack-trace, environment-specific,
  verbatim-code, investigation, uncertainty, self-correction, meeting-reference,
  pending-decision, version-pinned, metrics-change. Soft warnings only (never blocking).
  `recent-work` topic bypasses detection (ephemeral by design).
- **TF-IDF ephemeral classifier**: logistic regression over TF-IDF features trained on
  415 labeled cases (6 tech stacks: Python/Django, React/TypeScript, DevOps/infra,
  iOS/Swift, data engineering, Rust systems). Ships as `ephemeral-weights.json` (12KB).
  Fires as supplementary signal when regex misses (confidence: low). Combined benchmark:
  100% precision, 67.8% recall, 83.4% accuracy on 415 adversarial cases.
- **Context dedup hint**: `memory_context` responses include loaded keywords and topics
  to discourage redundant context calls within the same session.

## v1.1 — Quality of Life

### Global User Store
User identity and universal preferences stored in `~/.memory-mcp/global/`
instead of per-repo. Eliminates duplicating "My name is Etienne" across 4 repos.
Per-repo preferences stay per-repo. Global entries always included in briefings.

### ~~Basic Stemming~~ (done)
Naive stemming shipped in v0.1.0. Strips s/es/ing/ed/tion/ment/ness/ally/ies
suffixes. "reducers"→"reducer", "implementations"→"implement".

### Smarter Dedup — Known Gaps
Current hybrid (Jaccard+containment) with stemming catches obvious duplicates and
subset entries. Still misses:
- **Synonyms**: "error handling" vs "exception management" — zero keyword overlap.
  Fix: maintain a small synonym map for common programming terms
  (error↔exception, function↔method, class↔type, DI↔dependency-injection).
- **Acronym expansion**: "DI" vs "dependency injection", "MVI" vs "model-view-intent".
  Fix: acronym dictionary, expand before keyword extraction.
- **Semantic contradiction**: "use Impl prefix" vs "use Real prefix" — both mention
  "prefix" so they overlap, but the system doesn't know they *conflict*.
  Fix: requires v2 graph model with `contradicts` edge type, or a small
  negation/antonym detector for known pairs (impl↔real, mutable↔immutable,
  exception↔result, mock↔fake).
- **Cross-language equivalents**: "sealed class" (Kotlin) vs "enum with associated
  values" (Swift) — same concept, different terms. Fix: language-aware synonym
  map or embedding-based similarity (v3).

### Threshold Tuning
Current thresholds (0.35 dedup, 0.20 preference surfacing) are conservative.
Monitor real usage to see if:
- False negatives are common (threshold too high) — lower to 0.25/0.15
- False positives are annoying (threshold too low) — raise to 0.45/0.25
- Per-topic thresholds make sense (architecture entries are often long, gotchas
  are often short — different optimal thresholds)

### `memory_compact` Tool
Scan a topic for entries with high keyword overlap. Present groups to the agent
and suggest merging. Agent decides which to keep/merge/delete.

### `memory_refresh` Tool
Scan all entries with source files. Check git diff since stored SHA.
Report fresh/stale/broken counts. Agent or user runs this periodically or
at session start. Briefing footer already shows stale count.

### Rename Detection
`git log --follow` to detect renamed source files. Currently, renames show as
"source deleted" (false negative). Moderate perf cost — cache results.

### Contradiction Detection
When storing, check preferences for semantic conflicts (not just overlap).
Flag with higher urgency than simple dedup. E.g. "use Impl" vs "use Real".

### Auto-Preference from Corrections
When `memory_correct` is called with replace/append, analyze the correction.
If it looks like a generalizable rule (not a typo fix), auto-store as a
preference with `trust: agent-inferred` and let the user confirm.

## v1.2 — Signal Intelligence & Data Collection

### Ephemeral Signal Instrumentation (priority)
Record which ephemeral signal IDs fired at store time by persisting them in the
`MemoryEntry` as `ephemeralSignals?: string[]` (also written to disk as a metadata
line). Then at delete time, classify the outcome:
- Entry deleted within 24h with signals → **true positive** (signal was right)
- Entry deleted within 24h without signals → **false negative** (missed ephemeral)
- Entry survives 30+ days with signals → **false positive** (overly cautious)
- Entry survives 30+ days without signals → **true negative** (correct durable)

Log classification events to stderr. Over time this produces a confusion matrix
that tells us: which signals have high FP rates (tighten), which entries get
deleted quickly without any signal (add new patterns), and whether ML is needed.

~15 lines in store.ts (persist signals), ~10 lines in correct/delete path (classify),
~5 lines in types.ts. No external dependencies.

This is the prerequisite for any future ML: it generates labeled training data
passively from normal usage.

### Synonym & Acronym Maps for Dedup
Lightweight dictionary approach before jumping to embeddings:
- Synonym pairs: error↔exception, function↔method, class↔type, mock↔fake
- Acronym expansion: DI→dependency-injection, MVI→model-view-intent, VM→viewmodel
- Language equivalents: sealed-class↔enum-with-associated-values
Applied during keyword extraction in `text-analyzer.ts`. Improves dedup and
conflict detection without any ML dependency.

### Ephemeral Signal: Version/Date References
New signal for content containing version numbers or dates that will become stale:
- "React Router v5", "Gradle 8.2", "API v3"
- "As of February 2026", "since the Q4 release"
These are inherently time-bound facts. Medium confidence.

### Ephemeral Signal: Negation Without Alternative
Content that says what NOT to do without explaining the preferred approach:
- "Don't use GlobalScope" (but what should you use instead?)
- "Avoid MutableStateFlow" (but what's the alternative?)
Useful as a quality nudge: "Consider adding the recommended alternative."

### Contextual Ephemeral Thresholds
Some topics should have different ephemeral sensitivity:
- `gotchas` → higher sensitivity (gotchas about fixed bugs are the worst)
- `architecture` → lower sensitivity (architecture discussions naturally use
  hedging language like "we think X is the right approach")
- `user` → skip entirely (identity never ephemeral)
Configurable via `BehaviorConfig` or per-signal `skipTopics` in the registry.

### Store-Time Content Quality Scoring
Combine ephemeral signals, content length, reference count, and specificity
into a single quality score (0-1) returned in `StoreResult`. Not blocking —
just informational. Helps agents self-correct: "This entry scored 0.3/1.0
for long-term value. Consider adding more context or references."

## v2.0 — Knowledge Graph

Full design in `codebase-memory-mcp-design-thinking.md` (V2 section).

### Core Changes
- Entries become **nodes** in a graph
- **Typed, weighted edges**: `uses`, `prefers`, `contradicts`, `supersedes`, `related_to`, etc.
- **Activation spreading** replaces keyword search: seed nodes from context, spread along edges, return top-N activated nodes
- Topics become labels (just edges to label nodes), not hardcoded categories

### New Tools
- `memory_connect(from, to, type, weight)` — create/update graph edges
- `memory_context` upgraded to use spreading activation instead of keyword matching

### Storage
- `nodes/` directory (Markdown per node, same as v1 entries)
- `graph.json` adjacency list for fast traversal
- File-level locking for concurrent write safety on graph.json

### Edge Formation
1. Explicit: agent calls `memory_connect`
2. Implicit: co-occurrence in same session/same source files
3. Keyword-inferred: auto-connect on store if significant keyword overlap (Jaccard)

### Migration
Backward-compatible: existing entries become nodes, topic membership becomes edges,
keyword overlap becomes `related_to` edges with Jaccard-based weights.

### Open Questions
- Graph visualization in `memory_stats` (DOT output)?
- Merging graphs across worktrees with different edges?
- Edge confidence: own trust levels or inherited from nodes?
- Subgraph depth for briefings (N hops from user node)?

## v3.0 — Semantic Layer

### Embedding Service — Async, Optional, Additive

**Architecture**: a single embedding model serving multiple purposes (conflict detection,
dedup, context search reranking). Runs async after store returns — zero blocking latency.
Results surface on the next query/context/briefing call.

**Key design principles:**
1. **Purely additive**: removing the embedding model changes nothing — system falls back
   to keyword matching silently. No feature depends on embeddings being available.
2. **Async embedding**: `store()` returns immediately; background task embeds the entry
   and writes a `.vec` sidecar file alongside the `.md` entry.
3. **Pre-cached vectors**: at query/context/briefing time, embeddings are already cached
   from store-time. Cosine similarity between cached vectors is <1ms.
4. **Optional peer dependency**: `@huggingface/transformers` (ONNX runtime in Node.js).
   Users who want it: `npm install @huggingface/transformers`. Everyone else: zero change.

**Implementation plan:**
- `src/embeddings.ts`: lazy model loader, `embed()`, `batchEmbed()`, `cosineSimilarity()`
- `src/embedding-cache.ts`: read/write `.vec` files (float32, ~1.5KB each for 384-dim),
  in-memory cache (~300KB for 200 entries)
- Background task queue: simple `setTimeout`-based, processes entries after store returns
- Content hash stored alongside `.vec` for model version drift detection
- Atomic writes: `.vec.tmp` → rename to prevent corruption on process kill

**Integration points:**
- `detectConflicts()`: replaces keyword Jaccard with cosine similarity (primary win)
- `findRelatedEntries()`: same — catches synonym-level dedup
- `contextSearch()`: supplementary ranking signal when vectors are pre-cached
- `memory-config.json`: `{ "behavior": { "embeddingModel": "all-MiniLM-L6-v2" } }`

**Crash safety:**
- Partially written `.vec` files: atomic rename prevents corruption
- Queued but unprocessed entries: startup scan detects entries without `.vec`, re-queues
- Model download timeout: first session may lack embeddings; keyword fallback covers it

**When to build**: when knowledge bases regularly exceed ~200 entries and keyword-based
conflict detection produces noticeable false negatives in real usage.

Candidate models: all-MiniLM-L6-v2 (~23MB, 384-dim, fast), gte-small (better quality).

### ML-Based Ephemeral Classifier — Status: Shipped (TF-IDF)

**Shipped**: TF-IDF + logistic regression classifier (`ephemeral-weights.json`, 12KB).
Trained on 415 labeled cases across 6 tech stacks. 5-fold cross-validation:
precision=81.3%, recall=88.4%, F1=84.7%. Combined with regex signals:
100% precision, 67.8% recall on the full adversarial benchmark.

**Future upgrade path** (if needed):
- Option A: retrain with more data from ephemeral signal instrumentation (v1.2)
- Option B: zero-shot NLI model (DistilBERT-MNLI) via the embedding service infra
  — would catch hedging/uncertainty that TF-IDF misses, but adds model dependency
- Option C: fine-tuned classifier head on the embedding model
  — highest quality, but requires training infrastructure

**When to upgrade**: when the combined regex+TF-IDF approach drops below 60% recall
on real-world content, or when the embedding service is already deployed (piggyback).

### Passive Learning
Track which files the agent reads/edits across sessions. Infer hot modules, usage patterns.
Auto-create weak `related_to` edges from co-access patterns.
Could also track: which entries the agent queries most (boost those), which queries
return empty (knowledge gaps to fill), which stored entries the agent never reads
(candidates for pruning).

### Cross-Repo Knowledge Sharing
When bootstrapping a new Kotlin repo, offer to import relevant preferences/conventions
from other Kotlin repos. User-gated, never automatic. Requires the global user store
from v1.1. Could expose a `memory_import(from_lobe, to_lobe, topic)` tool.

### Auto-Briefing via MCP Resources (priority)
Instead of relying on agents to call `memory_briefing`, expose a
`memory://briefing` MCP resource that hosts (Firebender, Cursor) auto-inject
into conversations. Zero tool calls, zero agent unreliability.

**Design:**
- `memory://briefing/{lobe}` — lobe-specific micro-briefing (~100 tokens)
- `memory://briefing` — combined cross-lobe briefing
- `memory://user` — just user identity + preferences (always relevant)
- Content: user identity + active gotchas + stale count. Not full briefing.
- Host subscribes to resource updates; memory refreshes on file change.
- Agents still use `memory_context` for task-specific knowledge (pull).

**Why this matters:**
- Agents forget to call briefing. Rules help but are unreliable.
- `memory_briefing` wastes tokens on quick questions.
- Resources are the MCP-native solution: host decides when to inject,
  not the agent. Separates "always-on context" from "on-demand queries."
- `memory_context` remains the right tool for task-specific lookups.

**Requires:** MCP SDK resource support, host (Firebender) resource subscription.

### Push/Injection (exploratory)
Intercept other MCP tool calls to inject relevant memory context without the
agent explicitly querying. Requires MCP protocol extensions or middleware.
Lower priority than resource-based auto-briefing above.

### Agent Self-Assessment
After each session, the agent rates how useful memory was (1-5).
Track which entries were accessed and whether the session was productive.
Over time, prune low-value entries and reinforce high-value ones.
Requires a `memory_feedback(session_rating, helpful_entries, unhelpful_entries)` tool.

### Multi-Modal Knowledge
Store diagrams, architecture drawings, or screenshots as referenced assets.
Entry content stays Markdown but can link to `.git/memory/assets/arch-diagram.png`.
Useful for UI component memory ("this screen looks like X").
