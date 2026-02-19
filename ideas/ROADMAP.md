# Memory MCP Roadmap

## Current State (v0.1.0)

Flat topic-based store with one-file-per-entry. 8 tools, 63 tests passing.
Shared across worktrees via `.git/memory/`, branch-scoped recent-work.
Topics: user, preferences, architecture, conventions, gotchas, recent-work, modules/*.
Dedup via hybrid Jaccard+containment with naive stemming. Preference surfacing
on store. `memory_context` for keyword-based contextual search with topic boosting.
Piggyback hints on correct/store responses.

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

### Embedding-Based Search
Replace keyword extraction with lightweight local embeddings for `memory_context`.
Required if knowledge base grows beyond ~500 entries where keyword matching breaks down.
Candidate models: all-MiniLM-L6-v2 (fast, 384-dim), or gte-small (better quality).
Store embeddings alongside entries in a `.embeddings.json` sidecar file.
Query = embed context string, cosine similarity against all entries, top-N.

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
