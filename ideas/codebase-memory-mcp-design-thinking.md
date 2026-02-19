# Codebase Memory MCP - Design Thinking Document

## Context / Problem

AI coding agents suffer from complete amnesia between sessions. Every new chat starts with zero knowledge of the codebase, forcing repeated rediscovery of architecture, conventions, module relationships, and recent work. In large codebases (100k+ files), agents spend 30-60% of early interactions re-orienting before doing useful work.

Human developers carry years of institutional knowledge; agents currently have no equivalent persistent memory. Existing solutions (static rules files, READMEs) are hand-authored, don't evolve, and can't capture dynamic/emergent knowledge.

**Hard Constraints:**
- Must be an MCP server (stdio transport, standard MCP SDK protocol)
- Must not require external services — fully local operation
- Must handle stale/conflicting knowledge gracefully — wrong memory is worse than no memory
- Retrieval must be fast (<100ms)

**Soft Constraints:**
- Should work across multiple agent tools via MCP
- Should not require manual curation to be useful
- Storage should be human-readable/inspectable

**Non-negotiable Principles:**
- Correctness over completeness
- Transparency: every memory entry traceable to source
- Graceful degradation: empty memory = normal agent behavior
- User sovereignty: user can inspect, correct, delete any knowledge

**Anti-goals:**
- Not a code indexer (ripgrep/LSP handle that)
- Not a RAG/embedding system (v1)
- Not a replacement for prescriptive rules files
- Not cross-repo knowledge sharing
- Not conversation history storage

## Persona

### Persona Card (Primary): The AI Coding Agent

- **Name:** "Agent" (represents Firebender, Cursor, Claude Code, etc.)
- **Context:** Operates in large enterprise codebases (100k-1M+ lines), invoked multiple times daily for feature work, bug fixes, refactoring, cross-platform porting. Each session is stateless — context window is the only working memory.
- **Goals:**
  - Produce correct, convention-following code on the first try
  - Minimize back-and-forth with the human operator
  - Navigate unfamiliar modules quickly and accurately
  - Understand the "why" behind architectural decisions, not just the "what"
- **Pains:**
  - Every session starts cold — must re-read files, re-discover patterns, re-learn conventions
  - Can't distinguish between active code and deprecated code without extensive exploration
  - Makes convention mistakes because it infers patterns from a small sample of files rather than knowing the repo-wide standard
  - Wastes context window tokens on orientation instead of productive work
  - Has no memory of what it worked on yesterday, even if it's the same feature
- **Constraints:**
  - Limited context window (even large windows fill up with orientation)
  - Can only access tools exposed via MCP or IDE tooling
  - Can't run arbitrary background processes or maintain persistent state natively
  - Must respond in seconds, not minutes
- **Quotes/observations (from evidence):**
  - "I'll need to read a few files to understand the architecture..." (said in nearly every session)
  - "Based on the patterns I see in this file, I'll assume..." (inference from insufficient sample)
  - "I notice you use [X pattern] here — is this the standard across the codebase?" (asking what it should already know)

### Persona Card (Secondary): The Human Operator

- **Name:** "Dev" (the developer driving the agent)
- **Context:** Senior engineer at a large company, works across Android/iOS/backend. Uses AI agents daily for acceleration. Deep knowledge of the codebase they've built over years.
- **Goals:**
  - Get the agent to produce useful output with minimal re-explanation
  - Avoid repeatedly teaching the agent the same conventions
  - Trust the agent to make correct architectural decisions
- **Pains:**
  - Has to re-explain "we use MVI with standalone reducers" in every new session
  - Watches the agent make mistakes it was corrected on yesterday
  - Spends more time correcting agent output than it would take to write code directly (for well-understood tasks)
  - Can't hand off multi-session work to the agent because it forgets everything

## Phase 1: Empathize

### Journey Map

| Step | Action | Pain | Opportunity |
|------|--------|------|-------------|
| 1. New session | Agent starts fresh, no context | Zero knowledge, must orient from scratch | Pre-load known knowledge at session start |
| 2. Orientation | Agent reads README, key files, searches patterns | Burns 30-60% of productive capacity on rediscovery | Serve cached knowledge instantly |
| 3. First task | Agent attempts work, often with incomplete understanding | Makes convention mistakes, picks wrong patterns | Serve relevant conventions proactively |
| 4. Correction | Human corrects agent's mistakes | Frustrating repetition ("I told you yesterday...") | Persist corrections as high-confidence knowledge |
| 5. Mid-session | Agent has built up good context through the chat | This context dies when the session ends | Extract and persist valuable discoveries |
| 6. Next session | Back to step 1 | Complete amnesia | Session-to-session continuity via memory |

### Observations (5)

1. **O1**: Agents perform noticeably better in the second half of a session than the first half, because they've accumulated context — proving that accumulated knowledge directly improves output quality
2. **O2**: The workspace-mcp README and Firebender rules files together contain ~200 lines of static configuration — the human has already attempted to solve this problem with hand-authored knowledge, indicating strong demand
3. **O3**: When agents make convention mistakes (e.g., using `Impl` suffix instead of `Real` prefix), the correction is identical every time — these are highly cacheable
4. **O4**: Cross-platform porting (Kotlin to Swift) requires understanding conventions in BOTH repos simultaneously — the knowledge load doubles and cannot fit in static rules
5. **O5**: Git history shows which files change together frequently, which modules are active, and which conventions are actually followed — this structured data already exists but agents can't access it across sessions

### Insights (5)

1. **I1**: The cold-start problem is fundamentally a **knowledge caching** problem — the agent generates valuable knowledge during every session but discards it entirely (ref: O1)
2. **I2**: Human operators are already manually building a "memory system" through rules files, but it's static and doesn't scale (ref: O2) — the demand exists, the tooling doesn't
3. **I3**: Convention knowledge has extremely high ROI because mistakes are repeated identically across sessions (ref: O3) — even a simple key-value store of conventions would provide significant value
4. **I4**: The most valuable knowledge is **relationship knowledge** (module X depends on Y, pattern A is used in context B) which is hard to capture in flat rules files (ref: O4)
5. **I5**: The codebase itself contains implicit knowledge (in git history, file structure, naming patterns) that could be extracted automatically rather than requiring manual curation (ref: O5)

### Evidence

**Facts we have:**
- MCP protocol exists and works (workspace-mcp proves this)
- Firebender rules files demonstrate demand for persistent agent knowledge
- Agents lose all context between sessions (MCP protocol limitation)
- Local filesystem access is fast (<1ms for file reads)
- JSON is human-readable and inspectable

**Evidence gaps:**
- No data on actual session-over-session knowledge reuse rates
- No benchmarks on how much faster agents become with pre-loaded knowledge
- No understanding of optimal knowledge granularity (too fine = noise, too coarse = useless)
- No data on knowledge staleness rates (how fast does codebase knowledge decay?)

### Constraints (environment/tooling/model)

- MCP servers communicate via stdio — no persistent connections or background processes
- Agent context windows are finite — memory responses must be concise
- Multiple agents may access the same repo — need to handle concurrent reads (writes are less critical since agents rarely run simultaneously)
- Node.js runtime — single-threaded, must not block on I/O
- Storage must survive process restarts (filesystem-based)

### Observed Pain Themes (10)

1. **Cold start amnesia** — zero knowledge at session start
2. **Convention drift** — agent infers wrong patterns from small samples
3. **Repeated corrections** — human re-teaches the same lessons
4. **Wasted context window** — orientation consumes productive capacity
5. **Lost discoveries** — valuable insights from one session vanish
6. **No continuity** — multi-session features restart from scratch
7. **Stale mental model** — even when knowledge exists (rules files), it can be outdated
8. **Cross-domain blindness** — knowledge about module A doesn't transfer to module B
9. **Confidence gap** — agent can't distinguish "I know this" from "I'm guessing"
10. **No learning curve** — session 100 is as cold as session 1

### Unknowns (explicit list)

- What is the ideal knowledge granularity? (sentence-level facts vs paragraph-level summaries vs document-level overviews)
- How should conflicting knowledge be resolved? (newest wins? highest confidence? human arbitration?)
- What triggers knowledge extraction? (explicit agent action? automatic post-session? continuous?)
- How much knowledge is too much? (at what point does retrieval noise exceed signal?)
- Will agents actually use memory tools without heavy system prompting?
- How fast does knowledge decay in an actively developed codebase?

### Interpretation Risks (3)

1. **Over-generalizing cold start pain**: Some of the "orientation time" may actually be beneficial — agents reading fresh code catch things that stale memory would miss. We might be optimizing for speed at the cost of accuracy.
2. **Assumption that text-based knowledge is sufficient**: The most valuable knowledge might be structural (dependency graphs, call hierarchies) which doesn't compress well into text entries. Our text-first approach might miss the highest-value knowledge type.
3. **"Working as designed" risk**: Static rules files + READMEs might actually be the right solution for most cases. The dynamic learning aspect might add complexity without proportional value — the human might prefer to curate knowledge manually because they trust it more.

### Reflection

- **Symptoms vs root causes**: "Repeated corrections" (theme 3) is a symptom of "lost discoveries" (theme 5). "Convention drift" (theme 2) is a symptom of "cold start amnesia" (theme 1). The root causes are: (a) no persistence layer, and (b) no extraction mechanism.
- **To disprove our top interpretations**: If agents with pre-loaded knowledge produced WORSE code than cold-start agents (because stale knowledge misled them), that would disprove I1. If human operators stopped using rules files because they were more trouble than they're worth, that would disprove I2.

### Next Input Checklist

- Confirm the journey map captures the real workflow (or correct it)
- Which pain themes resonate most strongly from your daily experience?
- Any observations or pains I'm missing?
- Ready to proceed to Define (POV + HMW refinement)?

## Phase 2: Define

### POV (Point of View)

An **AI coding agent** working daily in a large codebase needs **persistent, evolving knowledge about the repo's architecture, conventions, and recent work context** because **every session starts from scratch, forcing repeated rediscovery that wastes 30-60% of productive capacity and produces convention-violating code that the human must correct**.

### Problem Statement

AI coding agents discard all accumulated codebase understanding when a session ends. This forces an expensive rediscovery cycle at the start of every session, produces convention mistakes from incomplete knowledge, and prevents multi-session continuity. The core issue is the absence of a persistence layer between the agent's ephemeral context and the static codebase — a layer that could cache, validate, and serve distilled knowledge on demand.

### Alternative Framings

1. **"It's not a memory problem, it's a prompting problem"**: Maybe the real issue is that agents aren't given good enough system prompts / rules files at session start. The solution might be better static knowledge engineering (richer `.firebender/` rules, auto-generated context files) rather than dynamic memory. This would be radically simpler — just better prompt templates.

2. **"It's not a persistence problem, it's a retrieval problem"**: Maybe agents already have access to enough information (the code itself, READMs, comments), they just can't find and synthesize it fast enough. The solution might be better search/indexing tools (semantic search, AST-aware querying) rather than a separate knowledge store.

Both framings are plausible. Framing 1 fails when knowledge is dynamic/emergent (gotchas, recent work context, cross-module relationships). Framing 2 fails when the knowledge doesn't exist in any single file (synthesized understanding, user corrections, convention rationale).

### How Might We (7)

- **HMW-1**: Give agents long-term memory that improves with every session?
- **HMW-2**: Ensure stored knowledge stays fresh and correct as code evolves?
- **HMW-3**: Let agents query knowledge at different granularity levels (overview vs deep-dive)?
- **HMW-4**: Make the memory system self-improving without requiring manual curation?
- **HMW-5**: Handle the cold start (first-ever session in a repo) gracefully?
- **HMW-6**: Let agents distinguish between high-confidence knowledge and uncertain inferences?
- **HMW-7**: Make knowledge storage lightweight enough that agents use it without being explicitly told to?

### Success Criteria (measurable)

- Agent can answer "what patterns does this repo use for X?" without reading any files (for known topics)
- Knowledge persists across sessions — session N+1 starts faster than session N
- Stale knowledge is detected within 1 session of the underlying code changing
- Query response time < 100ms for any single retrieval
- Human can inspect all stored knowledge in a human-readable format
- First session with empty memory degrades to normal agent behavior (no errors, no confusion)
- Knowledge store stays under 1MB for a typical large repo (not a data dump)
- Agent can query by topic, module, aspect, and detail level

### Key Tensions / Tradeoffs

| Tension | Option A | Option B |
|---------|----------|----------|
| **Correctness vs Coverage** | Store only high-confidence knowledge (less useful, never wrong) | Store everything with confidence scores (more useful, sometimes wrong) |
| **Passive vs Explicit learning** | Automatically infer knowledge from tool usage (scalable, noisy) | Require agent to explicitly store (precise, requires discipline) |
| **Granularity** | Fine-grained facts (flexible, many entries) | Coarse summaries (compact, fewer entries, less queryable) |
| **Freshness** | Aggressively expire old knowledge (safe, loses value) | Keep everything with staleness markers (complete, might mislead) |
| **Simplicity vs Power** | Simple key-value store (easy to build, limited queries) | Rich knowledge graph (powerful, complex to build and maintain) |

### Assumptions

- A1: Agents will use memory tools if they're available and well-described (not proven)
- A2: Text-based distilled knowledge is sufficient for v1 (embeddings not needed)
- A3: Knowledge granularity at the "paragraph summary" level is the right starting point
- A4: Local JSON/file storage is fast enough for <100ms retrieval
- A5: Knowledge extracted by AI agents is accurate enough to be useful when served back
- A6: The value of persistent knowledge exceeds the risk of stale/wrong knowledge

### Riskiest Assumption

**A6: The value of persistent knowledge exceeds the risk of stale/wrong knowledge.** If the codebase changes rapidly and knowledge decays faster than it's refreshed, the memory system could actively mislead agents — producing worse output than a cold-start agent that reads fresh code. This is the existential risk: wrong memory is worse than no memory.

### What Would Change Our Mind?

- If agents with pre-loaded (but potentially stale) knowledge produce MORE errors than cold-start agents, the whole premise fails
- If knowledge decay rate exceeds refresh rate in actively developed repos, the system is net-negative
- If agents consistently ignore memory tools in favor of reading files directly, adoption fails
- If the complexity of managing knowledge quality exceeds the time saved by having it, the ROI is negative

### Out-of-scope

- Embedding-based semantic search (v2+)
- Cross-repo knowledge sharing
- Conversation history storage
- Real-time code monitoring / file watchers
- Integration with specific CI/CD systems
- Knowledge about non-code artifacts (Jira tickets, Slack threads)

### Reflection

- **What would change our mind about the problem framing?** If better static rules files (Alternative Framing 1) solved 90% of the cold-start problem, dynamic memory is over-engineering. We should validate that static knowledge is insufficient before building dynamic knowledge.
- **What is the riskiest assumption?** A6 — that persistent knowledge is net-positive even when some of it is stale. The mitigation is aggressive freshness tracking and clear confidence signals to the agent.

### Proceeding to Ideation Readiness Check

- [x] POV is crisp and evidence-backed
- [x] Problem statement is specific (not just "agents should be smarter")
- [x] Alternative framings explored and addressed
- [x] Success criteria are measurable
- [x] Riskiest assumption identified with mitigation strategy
- [x] Out-of-scope is clear
- **Ready to proceed to Ideation.**

### Next Input Checklist

- Does the problem statement resonate? Any corrections?
- Do the alternative framings feel plausible or are they already ruled out in your experience?
- Any success criteria missing?
- Ready for ideation (divergent thinking on solutions)?

## Success Criteria

- [ ] Agent can query codebase knowledge without reading any files (for known topics)
- [ ] Knowledge persists across sessions and improves over time
- [ ] Stale knowledge is detected and flagged/removed automatically
- [ ] Query response time < 100ms for any retrieval
- [ ] Human can inspect and correct all stored knowledge
- [ ] First session with empty memory degrades gracefully to normal agent behavior
- [ ] Agent can query at different detail levels (overview vs deep-dive)
- [ ] Agent can query by specific aspect (module, pattern type, feature area)

## Idea Backlog

### Round 1: General Divergence

- **DT-001**: **Flat JSON knowledge store** — Store knowledge as an array of JSON objects in a single `.memory/knowledge.json` file. Each entry has topic, content, confidence, sources, timestamps. Simple grep-like retrieval by topic keyword matching.

- **DT-002**: **Tiered knowledge hierarchy** — Three tiers: Architecture (stable, high-level), Conventions (medium stability), Active Context (high churn). Different retention policies and query behavior per tier.

- **DT-003**: **Agent-explicit memory_store tool** — Agent explicitly calls `memory_store(topic, content, sources)` when it discovers something worth remembering. No passive learning. Maximum precision, requires agent discipline.

- **DT-004**: **Session summary extraction** — At the end of each session (or on explicit trigger), prompt the agent to summarize what it learned. Store the summary as a memory entry. Semi-automatic.

- **DT-005**: **Git-aware freshness tracking** — Every memory entry records the git SHA of referenced files. On retrieval, check if those files have changed since the SHA. If changed, mark the entry as potentially stale and include a warning.

- **DT-006**: **Confidence decay function** — Each memory entry's confidence decays over time (e.g., halves every 30 days). User confirmations and re-observations reset confidence to 1.0. Entries below a threshold are excluded from queries.

- **DT-007**: **Topic taxonomy** — Predefined set of topics (architecture, conventions, modules, patterns, gotchas, dependencies, testing, build). Agent tags entries with topics. Queries can filter by topic.

- **DT-008**: **Detail-level responses** — `memory_query(topic, detail: "brief"|"standard"|"full")` returns progressively more information. Brief = 1-3 bullets. Standard = paragraph. Full = everything including sources and confidence.

- **DT-009**: **memory_overview tool** — Single tool that returns a high-level summary of all known knowledge, grouped by topic. The "what do you know?" query. Useful at session start.

- **DT-010**: **Proactive knowledge injection** — Instead of the agent querying, the MCP injects relevant knowledge into responses based on the tool being called. E.g., when the agent reads a file in the messaging module, automatically append known context about that module.

- **DT-011**: **User correction flow** — `memory_correct(id, correction)` lets the human or agent fix wrong entries. Corrections get maximum confidence. Original entry is preserved in history for auditability.

- **DT-012**: **Bootstrap scan tool** — `memory_scan()` does a one-time broad analysis: reads README, scans directory structure, samples key files, parses package.json/build files. Seeds the knowledge base from cold start.

- **DT-013**: **Convention extractor** — Specialized tool that analyzes N files matching a pattern and extracts common conventions (naming patterns, import styles, architectural patterns). Stores as high-confidence convention entries.

- **DT-014**: **Module relationship mapper** — Analyze import statements across the codebase to build a module dependency graph. Store as structured knowledge. Queryable: "what depends on module X?"

- **DT-015**: **Per-file annotation store** — Instead of (or in addition to) topic-based knowledge, store annotations keyed by file path. When the agent reads a file, automatically surface annotations. "This file was last edited during the FlowCoordinator port. Known gotcha: the cache key format changed in v2."

- **DT-016**: **Markdown-based storage** — Store knowledge as structured Markdown files (one per topic or module) instead of JSON. More human-readable, version-controllable, editable in any editor. Less structured for programmatic queries.

- **DT-017**: **Conflict resolution via voting** — When conflicting knowledge exists, present both to the agent with timestamps and confidence. Let the agent (or user) resolve. Track resolution history.

- **DT-018**: **Knowledge graph with typed edges** — Entities (modules, patterns, files, conventions) connected by typed relationships (depends-on, uses-pattern, tested-by, deprecated-in-favor-of). Rich querying: "what patterns does module X use?"

- **DT-019**: **Session continuity bookmarks** — `memory_bookmark(description)` at end of session. Next session: `memory_resume()` returns the bookmark + related knowledge. Enables multi-session feature work.

- **DT-020**: **Passive observation via tool intercept** — The MCP wraps other tools (read, search, edit). When the agent reads files, the MCP silently notes which modules/files are accessed. Over time, builds a "hot path" map without explicit agent action.

- **DT-021**: **Knowledge TTL by type** — Architecture knowledge: 90-day TTL. Convention knowledge: 60-day TTL. Active context: 7-day TTL. Gotchas: no TTL (persist until explicitly removed). Different types decay at different rates matching their real stability.

- **DT-022**: **Inline knowledge in file reads** — When the agent uses `workspace_read`, prepend a small header with any known memory about that file/module. Zero extra tool calls required. Knowledge is served contextually.

- **DT-023**: **Structured vs freeform entries** — Support both structured entries (key-value pairs for conventions like `naming.prefix = "Real"`) and freeform entries (paragraph descriptions of architecture). Different query modes for each.

- **DT-024**: **Knowledge export as rules file** — `memory_export()` generates a `.firebender/` rules file from high-confidence knowledge. Bridges the gap between dynamic memory and static rules.

- **DT-025**: **Observation-only mode for v0** — The simplest possible v0: just `memory_store(key, value)` and `memory_query(key)`. No confidence, no freshness, no learning. Pure key-value persistence. Prove the concept before adding sophistication.

### Emerging Patterns (5)

1. **Storage format tension**: Multiple ideas pull toward either JSON (structured, queryable) or Markdown (human-readable, version-controllable). The right answer might be both — Markdown for human inspection, JSON index for programmatic access.
2. **Active vs passive learning**: Ideas split between explicit agent action (DT-003, DT-004) and automatic observation (DT-020, DT-022). The highest-value v1 is likely explicit-first with passive as a v2 enhancement.
3. **Freshness is a first-class concern**: Multiple ideas (DT-005, DT-006, DT-021) address staleness differently. Git-aware tracking (DT-005) is the most concrete and verifiable approach.
4. **Contextual injection**: Several ideas (DT-010, DT-015, DT-022) suggest pushing knowledge to the agent rather than waiting for queries. This reduces friction but risks noise.
5. **Start simple, grow smart**: DT-025 (key-value v0) vs DT-018 (knowledge graph) represent opposite ends of a complexity spectrum. The progression path matters: start simple, add sophistication based on real usage.

### Round 1 Reflections

- **Underrepresented categories**: Ideas around knowledge DELETION and PRUNING are thin — how does the system stay lean? Also missing: multi-agent coordination (two agents in the same repo) and knowledge migration (when repo structure changes significantly).
- **Simplest idea we're dismissing too quickly**: DT-025 (pure key-value store) might be 80% of the value at 10% of the complexity. The temptation to build a knowledge graph is strong, but a flat store with good naming conventions could work surprisingly well.
- **Assumption driving most ideas**: That the agent will remember to USE the memory tools. Almost every idea assumes the agent will query and store proactively. If agents don't naturally reach for memory tools, the entire system is unused. This points toward contextual injection (DT-010, DT-022) as a safety net.

### Round 2: Orthogonal / Unrelated Inspiration

**Analogy: Compiler symbol tables**
- **DT-026**: **Symbol table approach** — Like a compiler maintains a symbol table during parsing, the MCP maintains a "codebase symbol table" — not of code symbols, but of knowledge symbols. Each "symbol" has a scope (module, repo-wide), a type (convention, fact, relationship), and resolution rules (most-specific scope wins, like variable shadowing).

**Analogy: DNS caching**
- **DT-027**: **DNS-style TTL and hierarchical resolution** — Knowledge entries have TTLs like DNS records. When a query arrives, check local cache first (fast, possibly stale), then "authoritative source" (re-analyze the actual code, slow but fresh). Cache hits serve instantly; cache misses trigger refresh. Negative caching too: "I checked and this module has NO special conventions" prevents repeated futile lookups.

**Analogy: Game save states**
- **DT-028**: **Save points, not continuous memory** — Like game save states, don't try to remember everything continuously. Instead, let the agent create explicit "save points" at meaningful moments: after understanding a module, after completing a feature, after a major refactor. Each save point is a snapshot of understanding, not a stream of facts.

**Analogy: Aviation checklists**
- **DT-029**: **Pre-flight checklist pattern** — Like pilots use checklists before takeoff, the MCP generates a "session checklist" at start: "Here's what you should know before working in this repo." A structured brief, not a data dump. The checklist is curated from high-confidence knowledge and ordered by relevance to recent work.

**Analogy: Medical patient charts**
- **DT-030**: **Patient chart model** — The codebase is the "patient." Each session adds "clinical notes." There's a "problem list" (known issues, gotchas), "medication list" (active conventions/patterns), "history" (past work), and "vitals" (build status, test health). Different sections for different query needs. Structured around the entity (codebase) not the observer (agent).

**Analogy: Logistics route optimization**
- **DT-031**: **Frequently traveled routes** — Like logistics systems optimize for frequently-used routes, track which knowledge paths the agent queries most often and optimize for them. If the agent always asks about "messaging module conventions" first, pre-load that. Hot knowledge gets promoted to the top.

**Inversion: What if the agent NEVER queries memory?**
- **DT-032**: **Push-only architecture** — Flip the model: the agent never explicitly queries. Instead, the MCP injects relevant knowledge into EVERY tool response as a preamble. When the agent reads a file, the response includes known context. When it searches, results include annotations. Zero-friction, zero-query.

**Inversion: What if knowledge is NEVER stored by the agent?**
- **DT-033**: **Human-only curation** — The agent can only READ memory, never WRITE. All knowledge is authored by the human developer through a CLI or web UI. The agent is a consumer, not a producer. Maximum trust, zero noise from AI-generated knowledge. The memory system is essentially a structured knowledge base that the human maintains.

**Inversion: What if there's no persistent storage at all?**
- **DT-034**: **Ephemeral knowledge from code analysis** — No stored memory. Instead, each session starts with a fast code analysis pass (directory structure, git log, sample files) that generates fresh knowledge on the fly. "Memory" is actually real-time inference. Always fresh, never stale, but costs startup time.

**Constraint: Assume only plain text files (no JSON, no SQLite)**
- **DT-035**: **One-file-per-topic Markdown store** — `.memory/architecture.md`, `.memory/conventions.md`, `.memory/modules/messaging.md`. Each is a human-readable Markdown file. Querying = reading the right file. Storing = appending to the right file. No parsing, no schemas. The file system IS the database.

**Constraint: Assume no state between MCP restarts**
- **DT-036**: **Filesystem-as-truth, rebuild index on start** — All knowledge lives in Markdown files. When the MCP starts, it reads all `.memory/` files and builds an in-memory index. No separate database. If the MCP crashes, nothing is lost because the files are the source of truth. Index rebuild takes <100ms for typical knowledge sizes.

**Constraint: Assume the agent's context window is only 4K tokens**
- **DT-037**: **Extreme compression protocol** — All knowledge responses are compressed to the minimum. Instead of paragraphs, use structured shorthand: `[CONV] naming: Real prefix, not Impl suffix`. `[ARCH] MVI: Reducer(pure) -> ViewModel(orchestrator) -> Screen(stateless)`. Maximum information density per token.

**Constraint: Assume 100 agents hit the memory concurrently**
- **DT-038**: **Append-only log with read snapshots** — Like a database write-ahead log, all knowledge writes are appended to a single log file. Readers snapshot the log at read time. No locks, no conflicts. Compaction runs periodically (offline) to merge/deduplicate entries. Scales to any number of concurrent readers.

**Constraint: Assume the repo changes 100 times per day**
- **DT-039**: **Event-sourced knowledge with git hooks** — Every git commit triggers a knowledge invalidation pass: "which memory entries reference files changed in this commit?" Those entries get flagged for refresh. Knowledge is always tied to the code state it was derived from.

**Analogy: Spaced repetition (Anki)**
- **DT-040**: **Spaced repetition for knowledge reinforcement** — Knowledge entries that are accessed frequently and confirmed as correct get promoted (longer TTL, higher confidence). Entries that are never accessed decay and eventually get pruned. The system naturally retains useful knowledge and forgets unused knowledge — like an Anki deck for the codebase.

**Analogy: Wikipedia with talk pages**
- **DT-041**: **Knowledge entries with discussion trails** — Each memory entry has a "talk page" — a log of when it was created, accessed, confirmed, corrected, or disputed. The talk page provides auditability: "This convention was recorded by Agent session on Jan 5, confirmed by user on Jan 8, and the underlying file hasn't changed since."

**Analogy: Immune system (adaptive immunity)**
- **DT-042**: **Adaptive pattern recognition** — Like the immune system develops antibodies for encountered pathogens, the memory system develops "antibodies" for encountered problems. If the agent hits a build error caused by a specific pattern, the system remembers the error-pattern pair. Next time, it warns proactively: "Watch out: this import pattern causes build failures in this module."

### Interesting Analogies (3)

1. **DNS caching (DT-027)** creates the most non-obvious leverage: hierarchical resolution with TTLs, negative caching, and the concept of "authoritative refresh" directly maps to the freshness problem. It also suggests a natural caching strategy where "hot" knowledge stays in memory and "cold" knowledge is re-derived on demand.
2. **Aviation checklists (DT-029)** reframes the problem from "give the agent a database" to "give the agent a briefing." This is more human-centric and suggests the highest-value feature might be the `memory_overview` at session start, not fine-grained querying.
3. **Immune system (DT-042)** introduces the idea of error-driven learning: the most valuable knowledge isn't what the codebase IS, but what DOESN'T WORK. Gotcha-centric memory could be the highest-ROI knowledge type.

### Round 2 Reflections

- **Most non-obvious leverage**: The DNS analogy (DT-027) because it solves freshness, caching, and hierarchy in one coherent mental model. It also naturally handles the "authoritative source" question — the code itself is always the authoritative source, memory is just a cache.
- **Simplest idea dismissed too quickly**: DT-035 (one Markdown file per topic). No database, no index, no parsing. Just files. The agent reads `.memory/conventions.md` when it needs conventions. A human can edit it in VS Code. It's "stupid" but might be 90% of the value.
- **Assumption driving most ideas**: That knowledge needs to be STRUCTURED and INDEXED. Many ideas assume we need a database-like query system. But the DNS analogy and the Markdown-files approach suggest that simple file-based storage with good naming conventions might be sufficient — the filesystem IS the index.

### Round 3: Build-on / Combine / Mutate

- **DT-043**: **Markdown store + JSON index hybrid** (combines DT-035 + DT-036 + DT-001) — Knowledge is stored as human-readable Markdown files (one per topic/module). On MCP startup, an in-memory JSON index is built from the Markdown files' frontmatter (topic, confidence, sources, lastModified). Queries hit the index first, then read the relevant Markdown file. Best of both worlds: human-editable AND fast programmatic access.

- **DT-044**: **Briefing + Deep Dive dual-mode** (combines DT-029 + DT-008 + DT-009) — Two primary query modes: `memory_briefing()` returns a pre-flight checklist (aviation analogy) — a curated 200-token summary of the most important knowledge. `memory_query(topic, detail)` does targeted deep dives. The briefing is the default session opener; deep dives are on-demand.

- **DT-045**: **Git-aware TTL with DNS resolution** (combines DT-005 + DT-027 + DT-021) — Every entry stores the git SHA of its source files. On query, if the current SHA differs, the entry's confidence is reduced (not deleted). If confidence drops below a threshold, the response includes a staleness warning. Like DNS: serve the cached entry with a "may be stale" flag, let the agent decide whether to re-verify.

- **DT-046**: **Save points + session briefing** (combines DT-028 + DT-019 + DT-029) — End of session: agent calls `memory_checkpoint(summary)` to save a snapshot of current understanding. Start of session: `memory_briefing()` includes the last checkpoint plus high-confidence knowledge. This creates session-to-session continuity without continuous observation.

- **DT-047**: **Error-driven learning pipeline** (combines DT-042 + DT-011 + DT-040) — When the human corrects the agent, the correction is stored as a "gotcha" entry with maximum confidence. These entries never expire (unlike normal knowledge). Over time, the gotcha database becomes the most valuable knowledge — it's what Anki's spaced repetition would keep: things that are repeatedly needed.

- **DT-048**: **Explicit store + auto-extract on checkpoint** (combines DT-003 + DT-004 + DT-046) — During the session, the agent can explicitly store knowledge at any time. At checkpoint, the MCP also prompts/auto-extracts key facts from the session's tool usage (which files were read/written, what patterns were discussed). This is semi-passive: the bulk of knowledge comes from explicit stores, but checkpoints catch things the agent forgot to save.

- **DT-049**: **Convention template system** (DT-013 as a product primitive) — A built-in `memory_learn_conventions(glob_pattern, sample_count)` tool that reads N files matching a pattern, identifies common conventions (naming, structure, patterns), and stores them as structured convention entries. This is the bootstrap mechanism — run it once per module to seed conventions.

- **DT-050**: **Scoped queries via topic taxonomy** (combines DT-007 + DT-026 + DT-008) — Predefined topic scopes: `architecture`, `conventions`, `modules/{name}`, `patterns/{name}`, `gotchas`, `recent-work`. Queries are always scoped: `memory_query(scope: "modules/messaging", detail: "brief")`. Scoping prevents information overload and makes responses predictable.

- **DT-051**: **Push context on file access** (combines DT-022 + DT-032 + DT-015) — When integrated with workspace-mcp, any `workspace_read` or `workspace_search` call automatically appends known memory about the relevant file/module as a footer. Zero extra tool calls. The agent gets context without asking. This is the "push" complement to the "pull" of `memory_query`.

- **DT-052**: **Knowledge export pipeline** (combines DT-024 + DT-035 + DT-037) — `memory_export(format: "rules"|"markdown"|"compressed")` generates different output formats. "rules" creates a `.firebender/` rules file. "markdown" creates a human-readable knowledge dump. "compressed" creates a token-efficient format for small context windows. Bridge between dynamic memory and static knowledge.

- **DT-053**: **Layered storage: hot/warm/cold** (combines DT-002 + DT-031 + DT-040) — Hot layer: in-memory, most-accessed entries, served in briefings. Warm layer: on-disk Markdown files, served on query. Cold layer: archived entries with low confidence or access frequency, only served if explicitly requested. Automatic promotion/demotion based on access patterns.

- **DT-054**: **Multi-agent merge protocol** (fills gap from Round 1 reflections) — When two agents write conflicting knowledge, use a last-writer-wins strategy with conflict markers. On next query, surface conflicts: "Agent A said X on Jan 5, Agent B said Y on Jan 6. Which is correct?" Human resolution creates the highest-confidence entry.

- **DT-055**: **Progressive bootstrap** (combines DT-012 + DT-034 + DT-049) — First session: run lightweight scan (directory structure, README, git log summary) in <2 seconds. Store as initial knowledge. Subsequent sessions: the agent's explicit stores and checkpoints progressively enrich the knowledge. Convention extraction (DT-049) runs on-demand for specific modules. The system gets smarter over 5-10 sessions, not all at once.

### Candidate Concept Packages (5)

| Package | Member DT-IDs | What it enables |
|---------|---------------|-----------------|
| **A. "Simple Markdown Brain"** | DT-035, DT-036, DT-003, DT-008, DT-009, DT-025 | Minimum viable memory: Markdown files as storage, explicit store/query tools, human-editable. No magic, no inference. Start here. |
| **B. "Smart Cache"** | DT-043, DT-045, DT-027, DT-005, DT-006, DT-050 | Markdown storage + JSON index + git-aware freshness + TTL decay + scoped queries. The "DNS-inspired" approach: cached knowledge with staleness awareness. |
| **C. "Session Continuity Engine"** | DT-044, DT-046, DT-048, DT-019, DT-029, DT-055 | Focused on session-to-session flow: briefings, checkpoints, progressive enrichment. Optimized for the journey map pain points (steps 1, 5, 6). |
| **D. "Error-Driven Advisor"** | DT-047, DT-042, DT-011, DT-040, DT-029 | Focused on gotchas and corrections: the system primarily remembers what DOESN'T work. Highest-ROI for reducing repeated mistakes. |
| **E. "Full Knowledge Platform"** | DT-043, DT-044, DT-045, DT-046, DT-047, DT-050, DT-051, DT-053, DT-055 | Everything: layered storage, scoped queries, briefings, checkpoints, git freshness, error learning, push context. The "v2 vision" — too complex for v1 but defines the north star. |

### Round 3 Reflections

- **Missing critical primitive**: A "knowledge merge/dedup" operation. As the agent stores knowledge over many sessions, entries will overlap and partially conflict. Without dedup/merge, the store grows unboundedly and queries return redundant information. This is needed for Package B and E to work long-term.
- **Simplest idea dismissed too quickly**: Package A ("Simple Markdown Brain") with just explicit store/query and Markdown files. It's unglamorous, but it would validate the core hypothesis (persistent knowledge helps agents) with ~200 lines of code. Everything else is optimization.
- **Assumption driving most ideas**: That "smarter" = "better." Many combined ideas add sophistication (git tracking, TTL decay, layered storage). But the riskiest assumption (A6: value exceeds risk) is best tested with the simplest possible system, not the most sophisticated one.

### Round 4: Coverage Sweep & Blind Spot Hunt

**Security / Trust**
- **DT-056**: **Knowledge sandboxing** — Memory entries should never contain secrets, credentials, or PII. The MCP should reject stores that match common secret patterns (API keys, passwords, tokens). Also: memory files should be gitignore-able for repos where knowledge is sensitive.

- **DT-057**: **Trust levels for knowledge sources** — Three trust levels: `user` (human-authored, maximum trust), `agent-confirmed` (agent-stored, user confirmed), `agent-inferred` (agent-stored, unconfirmed). Query responses include trust level so the agent can weight accordingly.

**Performance / Scalability**
- **DT-058**: **Knowledge size budget** — Hard cap on total memory size (e.g., 2MB). When approaching the limit, lowest-confidence entries are pruned automatically. Prevents unbounded growth. The agent is warned when the budget is 80% consumed.

- **DT-059**: **Lazy loading with warm cache** — Only load knowledge into memory when first queried in a session. Keep a "warm cache" of the 20 most-accessed entries always in memory. Rest loaded on demand from disk. Startup time = near zero.

**Migration / Compatibility**
- **DT-060**: **Schema versioning for memory files** — Each memory file includes a `schemaVersion` field. When the MCP version upgrades and the schema changes, run an automatic migration on startup. Forward-compatible: old MCP can read new files (ignores unknown fields). Prevents "corrupt memory" after upgrades.

- **DT-061**: **Memory portability format** — `memory_export(format: "portable")` creates a single JSON file that can be shared, backed up, or transferred to another repo. `memory_import(path)` loads a portable export. Enables "seed this repo's memory from that repo's knowledge."

**Testing / Validation**
- **DT-062**: **Knowledge self-test tool** — `memory_validate()` checks all entries against their source files. Reports: X entries still valid, Y entries stale (source changed), Z entries broken (source deleted). Run periodically or on demand to maintain knowledge health.

- **DT-063**: **Dry-run mode for knowledge writes** — `memory_store(..., dryRun: true)` returns what WOULD be stored without actually writing. Useful for agents to preview before committing, and for testing the store pipeline.

**Observability / Dashboard**
- **DT-064**: **Memory health summary** — `memory_stats()` returns: total entries, by topic, by trust level, by freshness (fresh/stale/expired), by access frequency (hot/warm/cold), total size. Gives the human operator a bird's-eye view of knowledge health.

- **DT-065**: **Access log** — Log every memory read/write to `.memory/access.log` with timestamps. Enables analysis of which knowledge is actually used vs stored-but-ignored. Informs pruning decisions.

**Agent UX / Prompting**
- **DT-066**: **Tool descriptions that teach usage patterns** — The MCP tool descriptions should include usage examples and when-to-use guidance. E.g., `memory_briefing` description: "Call this at the start of every session to load context." This is how we solve the adoption problem (A1) without requiring system prompt changes.

- **DT-067**: **Suggested actions in responses** — When the agent queries and gets useful knowledge, the response suggests next actions: "You might also want to check `memory_query(scope: 'modules/networking')` for related conventions." When the agent stores knowledge, suggest: "Consider running `memory_validate()` to check freshness of related entries."

### Coverage Map

| Dimension | Coverage | Top DT-IDs |
|-----------|----------|------------|
| **Storage format** | High | DT-001, DT-035, DT-043, DT-016 |
| **Query interface** | High | DT-008, DT-009, DT-044, DT-050 |
| **Freshness / staleness** | High | DT-005, DT-006, DT-027, DT-045 |
| **Learning mechanism** | High | DT-003, DT-004, DT-048, DT-049 |
| **Session continuity** | High | DT-019, DT-028, DT-046, DT-044 |
| **Error/correction handling** | Med-High | DT-011, DT-042, DT-047 |
| **Security / trust** | Med | DT-056, DT-057 |
| **Performance / scaling** | Med | DT-058, DT-059, DT-038 |
| **Migration / compatibility** | Med | DT-060, DT-061 |
| **Testing / validation** | Med | DT-062, DT-063 |
| **Observability** | Med | DT-064, DT-065 |
| **Agent adoption UX** | Med | DT-066, DT-067 |
| **Multi-agent coordination** | Low | DT-054, DT-038 |
| **Push/contextual injection** | Low-Med | DT-022, DT-032, DT-051 |
| **Knowledge pruning/compaction** | Low | DT-058 (budget only) |

### Round 4 Reflections

- **Most likely regret**: Not exploring **knowledge pruning/compaction** deeply enough. Over months of use, the store will accumulate redundant, overlapping, and outdated entries. Without a dedup/merge strategy, query quality degrades. This needs to be solved before v1 ships, not after.
- **Category avoided because it felt "too big"**: **Push/contextual injection** (DT-032, DT-051). Integrating memory into workspace-mcp tool responses would be the most seamless UX but requires cross-MCP coordination or merging the two MCPs. We avoided it because it's architecturally complex. But it might be the killer feature.
- **Assumption driving most ideas**: That the agent is the primary interface. Many ideas focus on agent-facing tools. But the HUMAN is the one who decides whether to keep using the system. Human-facing UX (inspecting, editing, validating memory) may matter more for long-term adoption.

## Clusters

### C1: Storage & Format
How and where knowledge is persisted. Markdown files, JSON, hybrid, layered.
- DT-001, DT-016, DT-035, DT-036, DT-043, DT-053, DT-060, DT-061

### C2: Query Interface
How agents retrieve knowledge. Scoped queries, briefings, detail levels, overview.
- DT-008, DT-009, DT-029, DT-037, DT-044, DT-050

### C3: Learning & Ingestion
How knowledge enters the system. Explicit stores, checkpoints, convention extraction, bootstrap scans.
- DT-003, DT-004, DT-012, DT-013, DT-028, DT-046, DT-048, DT-049, DT-055

### C4: Freshness & Quality
How knowledge stays correct. Git tracking, TTL decay, confidence, validation, pruning.
- DT-005, DT-006, DT-021, DT-027, DT-040, DT-045, DT-058, DT-062

### C5: Error-Driven Learning
Corrections, gotchas, immune-system patterns. The most valuable knowledge type.
- DT-011, DT-042, DT-047

### C6: Session Continuity
Cross-session flow: bookmarks, checkpoints, briefings, resume.
- DT-019, DT-028, DT-029, DT-044, DT-046

### C7: Contextual Push
Injecting knowledge into other tool responses without explicit queries.
- DT-010, DT-015, DT-022, DT-032, DT-051

### C8: Trust & Security
Knowledge sandboxing, trust levels, secret detection.
- DT-056, DT-057

### C9: Observability & Ops
Health stats, access logs, validation, export, size budgets.
- DT-024, DT-052, DT-058, DT-064, DT-065

### C10: Agent Adoption
Tool descriptions, suggested actions, making the system feel natural.
- DT-025, DT-066, DT-067

## Candidate Directions

### Direction 1: "Simple Markdown Brain" (MVP)
**North Star**: The simplest possible persistent memory — Markdown files with explicit store/query tools — to validate that persistent knowledge helps agents produce better code.

- **Why now**: Proves the core hypothesis with minimal investment. If this doesn't help, nothing fancier will either.
- **Impact**: Moderate. Solves cold-start for explicit knowledge but doesn't learn automatically.
- **Risks**: Low. Simple enough that there's little to go wrong. Risk is mainly adoption (will agents use it?).
- **Migration cost**: None (greenfield).

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Impact | 3/5 | Solves explicit knowledge persistence but not auto-learning |
| Confidence | 5/5 | Extremely simple, very likely to work technically |
| Migration cost | 5/5 | Greenfield, no migration needed |
| Model-robustness | 5/5 | Works with any model that can call tools |
| Time-to-value | 5/5 | Buildable in 1-2 days |

### Direction 2: "Smart Cache" (Recommended v1)
**North Star**: A Markdown-stored, JSON-indexed, git-aware knowledge cache with scoped queries, confidence scoring, and staleness detection — the DNS-inspired approach to codebase memory.

- **Why now**: Adds the critical freshness/quality layer that makes knowledge trustworthy, not just persistent. Without staleness detection, the system accumulates wrong knowledge over time.
- **Impact**: High. Solves cold-start AND the stale knowledge risk.
- **Risks**: Medium. Git integration adds complexity. Confidence scoring needs tuning.
- **Migration cost**: Can start from Direction 1 and add features incrementally.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Impact | 4/5 | Adds freshness awareness, the key differentiator over static rules |
| Confidence | 4/5 | Well-understood patterns (caching, TTL), git integration is proven |
| Migration cost | 4/5 | Incremental from MVP, no breaking changes |
| Model-robustness | 4/5 | Works with any model, but confidence display requires model judgment |
| Time-to-value | 3/5 | 1-2 weeks to build properly |

### Direction 3: "Session Continuity Engine"
**North Star**: Optimized for the session handoff problem — briefings at start, checkpoints at end, progressive enrichment over sessions.

- **Why now**: Directly addresses the #1 pain point (journey map step 1 and 6). The briefing pattern from aviation is immediately intuitive.
- **Impact**: High for multi-session work, lower for one-off queries.
- **Risks**: Medium. Checkpoint quality depends on the agent's summarization ability. If checkpoints are bad, the system degrades.
- **Migration cost**: Can layer on top of Direction 2.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Impact | 4/5 | Highest impact on the specific session-continuity pain |
| Confidence | 3/5 | Depends on agent discipline for checkpoints, unproven |
| Migration cost | 4/5 | Layerable on top of any storage backend |
| Model-robustness | 3/5 | Checkpoint quality varies by model capability |
| Time-to-value | 3/5 | 1-2 weeks, but needs real usage to tune |

### Direction 4: "Error-Driven Advisor"
**North Star**: A system that primarily remembers what DOESN'T work — corrections, gotchas, and patterns that cause failures.

- **Why now**: Highest ROI per entry. A single gotcha entry can save hours of debugging across multiple sessions.
- **Impact**: High but narrow. Extremely valuable for the things it covers, but doesn't help with general orientation.
- **Risks**: Low technically, but requires corrections to flow into the system (depends on human/agent discipline).
- **Migration cost**: Can be a module within Direction 2.

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| Impact | 3/5 | High per-entry value but narrow scope |
| Confidence | 4/5 | Gotchas are stable, low staleness risk |
| Migration cost | 5/5 | Small, focused module |
| Model-robustness | 4/5 | Works with any model |
| Time-to-value | 4/5 | Buildable in days |

## Shortlist (Top 2-3)

1. **Direction 2: "Smart Cache"** — Best balance of impact, trustworthiness, and buildability. The git-aware freshness tracking is the key feature that makes this more than "just another knowledge store." Start with Direction 1's simplicity but build toward Direction 2's quality layer.

2. **Direction 3: "Session Continuity Engine"** — The briefing/checkpoint pattern is the most user-visible feature. Layer on top of Direction 2 as the primary UX.

3. **Direction 4: "Error-Driven Advisor"** — Build as a module within Direction 2. Gotchas and corrections get special treatment (never-expire TTL, maximum trust).

**Recommended path**: Build Direction 1 (MVP) in 1-2 days to validate. Immediately evolve to Direction 2 (Smart Cache) with Direction 4 (Error-Driven) as a built-in module. Add Direction 3 (Session Continuity) as the UX layer on top.

## Synthesis Reflections

- **What would falsify the top direction?** If agents consistently ignore `memory_query` tool calls even when available, or if the overhead of storing knowledge exceeds the time saved by retrieving it. A/B testing cold-start vs memory-assisted sessions would reveal this.
- **Most dangerous second-order effect**: Knowledge monoculture. If all agents read the same memory, they all make the same assumptions. A wrong entry propagates to every session. The confidence + staleness system mitigates this, but it's the deepest risk.

## Adversarial Challenge

**The skeptic's case against "Smart Cache"**: "You're building a database for a problem that's better solved by better prompts. Just put more detail in `.firebender/` rules, auto-generate context files from code analysis on each session, and skip the persistence layer entirely. Every session gets fresh analysis, never stale. No memory management, no staleness tracking, no pruning. Simpler, always correct."

**Strongest alternative**: Fresh-analysis-per-session (DT-034) avoids ALL staleness problems. If the bootstrap scan (DT-012) can run in <3 seconds and produce 80% of the value, persistence is unnecessary overhead. The counter-argument: fresh analysis can't capture HUMAN corrections and gotchas — those are the highest-value knowledge and they're inherently persistence-dependent.

## Decision Gate

**Proposed decision**: Proceed with Direction 2 ("Smart Cache") as the prototype target, incorporating Direction 4 (error-driven learning) as a core module and Direction 3 (session continuity) as the primary UX pattern. Build the MVP (Direction 1) first as the implementation starting point.

### Next Input Checklist
- Confirm or adjust the shortlisted direction
- Any strong feelings about the adversarial challenge?
- Ready to proceed to Prototype spec?

## Synthesis Quality Gate

- [x] POV statement is present (Phase 2: Define > POV)
- [x] 3-7 HMW questions are present (Phase 2: Define > HMW, 7 questions)
- [x] Success criteria are present and measurable (8 criteria with measurable targets)
- [x] Key tensions/tradeoffs are present (5 tensions in Phase 2 table)
- [x] Idea Backlog has meaningful breadth: storage (C1), querying (C2), learning (C3), freshness (C4), errors (C5), continuity (C6), push/injection (C7), security (C8), observability (C9), adoption (C10) - all covered
- [x] Shortlist (2-3) exists with risks and migration cost noted (3 directions shortlisted with scoring tables)
- [x] Top direction has at least one falsifiable learning question ("If agents consistently ignore memory_query tool calls even when available...")

**Result: PASS** - All checklist items satisfied.

## Decision Log

(Append-only record of key decisions with rationale)

- **DL-001**: Design doc path chosen as `ideas/codebase-memory-mcp-design-thinking.md`
- **DL-002**: Selected Direction 2 ("Smart Cache") as prototype target, with Direction 4 (error-driven) as core module and Direction 3 (session continuity) as UX layer. Rationale: best balance of impact, trustworthiness, and incremental buildability.

## Pre-mortem & Falsification

### Pre-mortem (Top 5 Failure Modes)

| Failure Mode | Why It Happens | Mitigation |
|---|---|---|
| **1. Agents never use memory tools** | Tool descriptions aren't compelling enough, or agents aren't prompted to check memory at session start | Write tool descriptions as usage instructions (DT-066). Add `memory_briefing` as the first suggested tool in the MCP description. Measure tool call rates in access logs. |
| **2. Stale knowledge misleads agents** | Code changes faster than knowledge is refreshed. Agent trusts stale entries and produces wrong code. | Git-SHA tracking on every entry. Staleness warnings in query responses. Confidence decay over time. Aggressive TTLs for high-churn knowledge types. |
| **3. Knowledge store grows unbounded** | Every session adds entries, nothing is pruned. Queries return noise. Storage exceeds budget. | Hard size budget (DT-058). Confidence-based pruning: entries below threshold are auto-removed. Access-frequency tracking to identify dead entries. |
| **4. Low-quality knowledge poisons the store** | Agent stores incorrect inferences as facts. These persist and mislead future sessions. | Trust levels (DT-057): agent-inferred entries get lower default confidence. User confirmations boost confidence. `memory_validate` tool for periodic health checks. |
| **5. Human finds the system untrustworthy and disables it** | Too many stale or wrong entries served. Human loses confidence in the system and removes it from MCP config. | Human-readable Markdown storage (inspectable). `memory_stats` for health visibility. `memory_correct` for easy fixes. Export as rules file so value isn't lost if memory MCP is removed. |

### Falsification Criteria

1. **If agents call memory tools <10% of sessions** after 2 weeks of availability, we will **pivot to push-only architecture** (DT-032/DT-051) because the explicit query model has failed adoption. The tools are available but unused = wrong interface.

2. **If >30% of served knowledge entries are stale** (source files changed since entry creation) after 1 month, we will **add mandatory git-hook refresh** (DT-039) or **switch to ephemeral analysis** (DT-034) because the persistence model creates more harm than value.

3. **If human operators report correcting memory-induced errors more than once per week**, we will **restrict memory to read-only mode with human-only curation** (DT-033) because AI-authored knowledge quality is insufficient.

### Pre-mortem Reflections

- **Most dangerous second-order effect**: Knowledge monoculture. If every session reads the same memory, every session makes the same assumptions. When those assumptions are wrong, the error is systematic and hard to detect because it's consistent. This is worse than random errors from cold-start agents. Mitigation: always include confidence and staleness in responses so the agent can choose to verify.

- **What we'd regret not testing**: Whether agents actually produce better code with pre-loaded knowledge. We're assuming this is true (A6) but haven't measured it. Before building the full system, run a controlled experiment: manually pre-load knowledge in system prompts for 10 sessions, compare code quality against 10 cold-start sessions.

### Proceed to Prototype Confirmation

The pre-mortem identified real risks but all have concrete mitigations. The falsification criteria provide clear kill/pivot signals. The riskiest assumption (A6: value > risk) can be tested with the MVP. Ready to prototype.

## Prototype Spec

### Learning Question
**Does persistent, queryable codebase knowledge measurably improve agent session starts and reduce convention errors?**

### Prototype Type
API Sketch — request/response examples with mocked outputs for all MCP tools.

### Smallest Shippable Slice
5 tools: `memory_store`, `memory_query`, `memory_briefing`, `memory_correct`, `memory_stats`. Markdown file storage. No git tracking, no TTL decay, no confidence scoring. Pure persistence layer. If this helps, add sophistication. If it doesn't, stop.

### Prototype Artifact: API Sketch

#### Storage Format

`.memory/` directory at the target repo root:

```
.memory/
  index.json              # In-memory index rebuilt on startup
  architecture.md         # Topic file
  conventions.md          # Topic file
  modules/
    messaging.md          # Per-module knowledge
    networking.md
  gotchas.md              # Never-expire entries
  recent-work.md          # High-churn session context
```

Each Markdown file has YAML frontmatter:

```markdown
---
topic: conventions
entryCount: 4
lastModified: 2026-02-18T10:30:00Z
---

## Naming Conventions
- **id**: conv-001
- **confidence**: 0.95
- **source**: src/features/messaging/RealMessagingRepository.kt
- **created**: 2026-02-15
- **trust**: agent-confirmed

Use `Real` prefix instead of `Impl` suffix for implementation classes.
Example: `RealMessagingRepository` not `MessagingRepositoryImpl`.

---

## Error Handling
- **id**: conv-002
- **confidence**: 0.90
- **source**: libraries/illuminate/common/usecase/ResultUseCase.kt
- **created**: 2026-02-16
- **trust**: agent-inferred

Use `Result<T>` for error handling, never throw exceptions.
Use `runCatching` in non-suspend code, `suspendRunCatching` in suspend functions.
```

#### Tool: `memory_store`

Store a knowledge entry.

```typescript
// Request
memory_store({
  topic: "conventions",          // Required: architecture|conventions|modules/{name}|gotchas|recent-work
  title: "Naming Conventions",   // Required: entry title
  content: "Use Real prefix...", // Required: the knowledge
  sources: ["src/features/messaging/RealMessagingRepository.kt"],  // Optional: evidence files
  trust: "agent-inferred"        // Optional: agent-inferred (default) | agent-confirmed | user
})

// Response (success)
{
  "stored": true,
  "id": "conv-001",
  "topic": "conventions",
  "file": ".memory/conventions.md",
  "confidence": 0.70,           // Default for agent-inferred
  "warning": null
}

// Response (overwrite warning)
{
  "stored": true,
  "id": "conv-001",
  "topic": "conventions",
  "file": ".memory/conventions.md",
  "confidence": 0.70,
  "warning": "Overwrote existing entry 'Naming Conventions'. Previous content preserved in history."
}
```

#### Tool: `memory_query`

Query knowledge by topic and detail level.

```typescript
// Request
memory_query({
  scope: "conventions",          // Required: topic or "modules/messaging" or "*" for all
  detail: "brief",               // Optional: brief (default) | standard | full
  filter: "naming"               // Optional: keyword filter within scope
})

// Response (brief)
{
  "scope": "conventions",
  "detail": "brief",
  "entries": [
    {
      "id": "conv-001",
      "title": "Naming Conventions",
      "summary": "Use Real prefix, not Impl suffix. Example: RealMessagingRepository.",
      "confidence": 0.95,
      "fresh": true
    },
    {
      "id": "conv-002",
      "title": "Error Handling",
      "summary": "Use Result<T>, never throw. runCatching / suspendRunCatching.",
      "confidence": 0.90,
      "fresh": true
    }
  ],
  "totalEntries": 2
}

// Response (full) - adds sources, timestamps, trust level, full content
{
  "scope": "conventions",
  "detail": "full",
  "entries": [
    {
      "id": "conv-001",
      "title": "Naming Conventions",
      "content": "Use `Real` prefix instead of `Impl` suffix for implementation classes.\nExample: `RealMessagingRepository` not `MessagingRepositoryImpl`.",
      "confidence": 0.95,
      "trust": "agent-confirmed",
      "sources": ["src/features/messaging/RealMessagingRepository.kt"],
      "created": "2026-02-15T00:00:00Z",
      "lastAccessed": "2026-02-18T10:30:00Z",
      "fresh": true,
      "stalenessNote": null
    }
  ],
  "totalEntries": 1
}
```

#### Tool: `memory_briefing`

Session start briefing — the pre-flight checklist.

```typescript
// Request
memory_briefing({
  maxTokens: 500               // Optional: target response size (default: 500)
})

// Response
{
  "briefing": "## Session Briefing\n\n### Architecture\n- MVI pattern: Reducer (pure) → ViewModel (orchestrator) → Screen (stateless)\n- Anvil DI with @ContributesBinding(AppScope::class)\n- Clean Architecture: UseCase → Repository → DataSource\n\n### Key Conventions\n- Real prefix, not Impl suffix\n- Result<T> for errors, never throw\n- Sealed interfaces over sealed classes\n- Immutable data classes for UI state\n\n### Active Gotchas\n- [!] messaging module: cache key format changed in v2, don't use v1 keys\n- [!] networking: retry interceptor swallows 429s silently\n\n### Recent Work\n- Last session: porting FlowCoordinator from Kotlin to Swift (messaging module)\n- Checkpoint: KeyReducer.swift drafted, needs type-check validation",
  "entryCount": 12,
  "staleEntries": 1,
  "oldestEntry": "2026-02-01T00:00:00Z",
  "suggestion": "Consider running memory_query(scope: 'modules/messaging', detail: 'full') for your recent FlowCoordinator work."
}
```

#### Tool: `memory_correct`

Fix or annotate existing knowledge.

```typescript
// Request
memory_correct({
  id: "conv-001",
  correction: "Also applies to UseCase classes: RealFetchUserUseCase not FetchUserUseCaseImpl",
  action: "append"               // append | replace | delete
})

// Response
{
  "corrected": true,
  "id": "conv-001",
  "action": "append",
  "newConfidence": 1.0,          // Corrections always get max confidence
  "trust": "user"                // Corrections are user-trust by default
}
```

#### Tool: `memory_stats`

Health dashboard.

```typescript
// Request
memory_stats()

// Response
{
  "totalEntries": 24,
  "byTopic": {
    "architecture": 3,
    "conventions": 8,
    "modules/messaging": 5,
    "modules/networking": 3,
    "gotchas": 3,
    "recent-work": 2
  },
  "byTrust": { "user": 5, "agent-confirmed": 12, "agent-inferred": 7 },
  "byFreshness": { "fresh": 20, "stale": 3, "expired": 1 },
  "storageSize": "42KB",
  "storageBudget": "2MB",
  "oldestEntry": "2026-02-01",
  "newestEntry": "2026-02-18",
  "suggestion": "3 stale entries found. Run memory_validate() to check them."
}
```

### Falsification Criteria (from Phase 4B)

1. If agents call memory tools <10% of sessions after 2 weeks, pivot to push-only architecture
2. If >30% of served entries are stale after 1 month, add mandatory git-hook refresh or switch to ephemeral analysis
3. If human operators correct memory-induced errors more than once per week, restrict to human-only curation

### Prototype Reflections

- **Smallest shippable slice**: Just `memory_store` and `memory_query` with Markdown file storage. No briefing, no stats, no correction. If agents can store and retrieve knowledge, and that knowledge helps in subsequent sessions, the concept is proven. Everything else is UX polish.
- **Highest-risk assumption**: That agents will call `memory_briefing` at session start without being told to. The tool description needs to be explicit: "Call this first in every session." If agents don't, the whole session-continuity value proposition fails.
- **If falsification triggers**: Fall back to Direction 4 (Error-Driven Advisor) — a much narrower scope focused only on gotchas and corrections. This has the highest per-entry ROI and lowest staleness risk since gotchas are stable knowledge.

### Next Input Checklist
- Does the API sketch feel right? Any tools missing or unnecessary?
- Is the Markdown storage format acceptable, or prefer JSON-only?
- Any concerns about the tool naming / parameter design?
- Ready for Test Plan?

## Test Plan

### Goal
Validate that persistent codebase memory measurably improves agent session quality — faster orientation, fewer convention errors, better multi-session continuity.

### Test Duration
2 weeks of daily dogfooding, followed by 1-week quantitative evaluation.

### Agents/Models/IDEs to Test

| Agent/IDE | Model | Role |
|-----------|-------|------|
| Firebender (primary) | Claude Opus/Sonnet | Primary dogfood environment — daily use in ZillowMap Android repo |
| Cursor | Claude Sonnet | Secondary validation — different IDE, same model family |
| Firebender | GPT-4o | Weaker model test — validates model-robustness (do less capable models still use memory tools effectively?) |

### Test Scenarios

#### Scenario 1: Cold Start vs Memory-Assisted (Quantitative)
- **Setup**: 10 sessions with memory MCP enabled, 10 sessions without (cold start)
- **Task**: Same task type each session (e.g., "add a new UseCase following repo conventions")
- **Measure**: Time to first correct code output, number of convention errors, number of files read before producing code
- **Pass criteria**: Memory-assisted sessions are 30%+ faster to first correct output

#### Scenario 2: Session Continuity (Qualitative)
- **Setup**: Multi-session feature (e.g., porting a component from Kotlin to Swift)
- **Task**: Session 1: understand the component. Session 2: start porting. Session 3: finish and validate.
- **Measure**: Does session 2 start with context from session 1? Does the agent reference checkpointed knowledge?
- **Pass criteria**: Agent references previous session's checkpoint in briefing

#### Scenario 3: Gotcha Prevention (Qualitative)
- **Setup**: Store 3 known gotchas via `memory_store`. Start a new session where the agent would encounter one.
- **Task**: Agent works on code that historically triggers the gotcha
- **Measure**: Does the agent avoid the gotcha? Does it reference the stored knowledge?
- **Pass criteria**: Agent avoids at least 2/3 known gotchas

#### Scenario 4: Stale Knowledge Handling (Correctness)
- **Setup**: Store knowledge about a file. Modify the file. Query the knowledge.
- **Measure**: Does the response include a staleness warning?
- **Pass criteria**: 100% of stale entries are flagged (for git-aware version; N/A for MVP)

#### Scenario 5: Weaker Model Compatibility (Robustness)
- **Setup**: Run scenarios 1-3 with GPT-4o instead of Claude
- **Measure**: Does the weaker model discover and use memory tools? Does it store useful knowledge?
- **Pass criteria**: GPT-4o uses memory tools in >50% of sessions and stores at least 1 useful entry per session

### Metrics to Track

| Metric | Source | Target |
|--------|--------|--------|
| Tool call rate | `.memory/access.log` | >80% of sessions call `memory_briefing` |
| Entries stored per session | `memory_stats` | >1 per session average |
| Stale entry ratio | `memory_stats` | <20% after 2 weeks |
| Human corrections per week | Manual tracking | <3 per week |
| Convention error rate | Manual review | 50%+ reduction vs cold start |
| Session start time | Qualitative | Noticeably faster (subjective) |

### Failure Actions

- **If tool call rate <10%**: Pivot to push-only injection (DT-032). The query model failed adoption.
- **If stale ratio >30%**: Add git-hook integration or switch to ephemeral analysis.
- **If human corrections >1/week**: Restrict to human-only curation mode.
- **If GPT-4o can't use tools effectively**: Add explicit system prompt instructions as an MCP resource.
- **If no measurable improvement**: Stop. The core hypothesis is wrong. Invest in better static rules files instead.

### Test Reflection

If the test fails on adoption (agents don't use tools), iterate on tool descriptions and try push-only injection before giving up entirely. If it fails on quality (stale/wrong knowledge), tighten the quality controls (git tracking, lower default confidence, faster TTL). If it fails on both, stop — the concept isn't viable for the current generation of agents.

## Iteration Notes

### Iteration 1: Thought Experiment & Adversarial Critique

**Test method**: Mental walkthrough of the prototype API against real usage patterns, plus adversarial critique from a skeptic's perspective.

#### Walkthrough: Day 1 (Empty Memory)

1. Agent starts session. Calls `memory_briefing()`. Response: "No knowledge stored yet. Consider running a bootstrap scan or storing observations as you work."
2. Agent reads files, discovers MVI pattern. Calls `memory_store(topic: "architecture", title: "MVI Pattern", content: "...")`.
3. Agent works on a feature. Makes a naming mistake. Human corrects: "Use Real prefix."
4. Agent calls `memory_store(topic: "conventions", title: "Naming", content: "Real prefix not Impl suffix", trust: "user")`.
5. Session ends. 2 entries stored.

**Observation**: Day 1 feels like overhead — the agent is doing extra work to store knowledge it just learned in-session. **The value doesn't appear until Day 2.**

#### Walkthrough: Day 2 (With Memory)

1. Agent starts session. Calls `memory_briefing()`. Response includes: architecture (MVI), conventions (Real prefix). **Agent immediately knows conventions without reading any files.**
2. Agent starts new feature in a different module. Already knows the naming convention. Produces correct code on first try.
3. Agent discovers a gotcha: "networking module's retry interceptor swallows 429s." Stores it.
4. Session ends. 3 entries total.

**Observation**: Day 2 shows clear value. The naming convention is applied correctly without re-teaching.

#### Walkthrough: Day 10 (Rich Memory)

1. `memory_briefing()` returns a comprehensive briefing: architecture, 8 conventions, 3 gotchas, recent work context.
2. Agent navigates confidently. Produces convention-following code across modules.
3. However: one stored convention is now wrong (the team switched from `Result<T>` to a custom `Outcome<T>` sealed class last week).
4. Agent uses the stale convention. Human corrects. Agent calls `memory_correct`.

**Observation**: Stale knowledge caused an error. Without git-aware freshness (not in MVP), this will happen. **This validates the need for Direction 2's freshness tracking as a fast-follow.**

#### Adversarial Critique

**Skeptic**: "This is just a structured note-taking app for AI agents. You've built a todo list that the agent has to maintain. The overhead of storing and managing knowledge will exceed the time saved."

**Response**: Valid concern. Mitigations: (1) The store operation is one tool call, ~100ms. The savings are minutes of file reading per session. ROI is positive even with low storage rates. (2) If the overhead concern proves true in testing (agents store too much noise or too little signal), we pivot to push-only injection where the agent doesn't manage memory at all.

**Skeptic**: "The briefing will be too long and waste context window. Agents will get a wall of text they don't need."

**Response**: The `maxTokens` parameter on `memory_briefing` caps response size. Brief mode uses 1-line summaries. The agent can query deeper only when needed. But this IS a real risk — if briefings are consistently too verbose, agents may stop calling them.

**Skeptic**: "Why not just put this in the system prompt? Firebender rules already do this."

**Response**: Rules are static and hand-authored. Memory evolves with usage. The key difference is corrections and gotchas — things the agent discovers during work that don't belong in a rules file. Rules say "what to do." Memory says "what we learned."

#### Feedback Summary

| Signal | Observation | Action |
|--------|-------------|--------|
| **Positive** | Day 2+ walkthrough shows clear value for convention knowledge | Proceed with MVP |
| **Positive** | Gotcha storage has highest per-entry ROI | Prioritize gotcha handling in v1 |
| **Negative** | Day 1 feels like overhead — no immediate payoff | Add bootstrap scan (DT-012) to seed initial knowledge faster |
| **Negative** | Stale knowledge caused an error in Day 10 walkthrough | Git-aware freshness (DT-005) is critical for v1.1, not optional v2 |
| **Neutral** | Briefing verbosity is a risk | Default to very brief summaries; let agent request more detail |

#### Refinements from Iteration 1

1. **Add `memory_bootstrap` tool to MVP scope** — A lightweight scan that reads README, directory structure, and samples key files to seed initial knowledge. Reduces the Day 1 overhead problem.
2. **Default briefing to ultra-brief** — 200 tokens max, one-liners only. Agent can call `memory_query` for depth.
3. **Promote git-aware freshness from v1.1 to v1** — The Day 10 walkthrough showed staleness is a real problem even within 2 weeks. Can't ship without it.
4. **Gotchas get special treatment** — Never-expire TTL, always included in briefings, highest display priority.

### Iteration 1: Updates Applied

#### Changes Made

- **POV**: No change. Core problem framing validated by walkthrough.
- **HMW**: Added HMW-8: "How might we reduce Day 1 overhead so the system provides value from the first session?"
- **Shortlist**: Promoted git-aware freshness from "v1.1 nice-to-have" to "v1 requirement." Added `memory_bootstrap` to MVP tool set.
- **Prototype spec**: Updated tool list from 5 to 6 tools (added `memory_bootstrap`). Changed default briefing size from 500 to 200 tokens. Added gotcha priority rules.

#### Updated MVP Tool Set (6 tools)

1. `memory_store` — explicitly store knowledge
2. `memory_query` — scoped, detail-leveled retrieval
3. `memory_briefing` — session-start pre-flight checklist (200 tokens default)
4. `memory_correct` — fix/annotate existing entries
5. `memory_stats` — health dashboard
6. `memory_bootstrap` — lightweight initial scan to seed knowledge on first use

#### Rationale

The Day 1 overhead problem (agent does extra work to store knowledge with no immediate payoff) is an adoption killer. `memory_bootstrap` solves this by seeding the store automatically on first use, so Day 1 already has useful knowledge. Git-aware freshness was promoted because the Day 10 walkthrough showed stale knowledge causing real errors within 2 weeks — this can't wait for v1.1.

#### Reflection

- **What surprised us**: The Day 1 experience matters more than we thought. We focused on the "steady state" (Day 10+) but adoption depends on Day 1 being useful. If the first session feels like overhead with no payoff, the human disables the MCP.
- **What we previously believed that is now false**: We assumed freshness tracking was a "nice to have" for v1.1. The walkthrough showed it's table stakes — without it, trust erodes within 2 weeks.

### Iteration 2: Stakeholder Q&A Simulation

**Test method**: Simulated Q&A with a skeptical senior engineer and a pragmatic product manager.

#### Q&A: Senior Engineer (Skeptic)

**Q: "How is this different from just writing better comments in code?"**
A: Comments describe what code does. Memory describes what the codebase IS — architectural patterns, cross-cutting conventions, relationships between modules, and especially gotchas that live nowhere in the code. Comments are per-file; memory is repo-wide synthesis.

**Q: "What happens when I refactor and move files? Does all the memory break?"**
A: Git-aware freshness tracks file SHAs. When files move/change, related entries get flagged as stale. The agent sees: "This knowledge may be outdated (source file changed)." It's not magic — the agent still needs to re-verify — but it won't blindly trust stale knowledge. This is an area for improvement: tracking file renames specifically.

**Q: "I don't want AI-generated garbage cluttering my repo with `.memory/` files."**
A: `.memory/` is gitignore-able. It's local to your machine by default. If you want to share knowledge with your team, you can commit it. If not, it stays local. The files are plain Markdown — you can read, edit, or delete them in any editor.

**Q: "What's the disk cost? I have 50 repos."**
A: Typical memory store is 10-100KB per repo. Hard cap at 2MB. This is negligible. Each repo has its own independent `.memory/` — no cross-repo sharing, no central database.

#### Q&A: Product Manager (Pragmatist)

**Q: "What's the first thing a user sees? How do we demo this?"**
A: Demo flow: (1) Register the MCP. (2) Start a chat. (3) Ask the agent to work on something. (4) Agent calls `memory_briefing`, gets "no knowledge yet", proceeds normally. (5) Agent discovers patterns, stores them. (6) Start a NEW chat. (7) Agent calls `memory_briefing`, gets the stored knowledge. (8) Agent produces correct code immediately without re-reading files. The "aha moment" is step 7 — the new session starts with knowledge.

**Q: "How long until it's useful? What's time-to-value?"**
A: With `memory_bootstrap`: useful from session 1 (auto-scans directory structure, README). Without it: useful from session 2 (after agent stores first observations). Full value after 5-10 sessions.

**Q: "Can this work without Firebender? We have Cursor users too."**
A: Yes. It's a standard MCP server. Any MCP-compatible agent can use it. Tool descriptions are self-documenting. No Firebender-specific features.

#### Feedback Summary (Iteration 2)

| Signal | Observation | Action |
|--------|-------------|--------|
| **Risk** | File rename tracking is a gap — git SHA only catches content changes | Add file path tracking with git rename detection as v1.1 enhancement |
| **Positive** | .memory/ being gitignore-able resolves the "clutter" concern | Document this prominently in README |
| **Positive** | Cross-MCP-client compatibility is a selling point | Test with Cursor early in dogfood |
| **UX** | The "aha moment" is session 2, not session 1 | Bootstrap scan is critical to make session 1 impressive |
| **Positive** | Disk cost is negligible at <100KB | Confirm with real usage metrics |

### Iteration 2: Updates Applied

#### Changes Made

- **POV**: No change.
- **HMW**: No change (HMW-8 from Iteration 1 still covers the bootstrap concern).
- **Shortlist**: No change to direction. Added file rename tracking to v1.1 roadmap.
- **Prototype spec**: Added note that `.memory/` should be gitignored by default with opt-in commit. Added Cursor to test plan alongside Firebender.

#### Rationale

Iteration 2 validated the design rather than challenged it. The main new insight was that the "aha moment" demo flow (session 1 → session 2) is the clearest way to communicate value. The skeptic's concerns were addressable with existing design decisions (gitignore-able, freshness tracking, human-readable format).

#### Reflection

- **What surprised us**: The senior engineer's concern about file renames was specific and real — our git SHA tracking doesn't handle renames. This is a genuine gap, but solvable with `git log --follow` in v1.1.
- **What we previously believed that is now false**: Nothing fundamentally changed. The design held up well under Q&A. The biggest risk remains adoption (will agents actually use the tools?), which can only be validated with real usage.

---

## V2 Design: Knowledge Graph Model

*Recorded: 2026-02-18. Decision: v2 target. Ship flat v1 first, evolve to graph.*

### Motivation

The flat topic-based model (v1) works but hits fundamental limitations:
- **Tags fight per-repo scoping**: language-specific preferences need filtering that topics don't provide
- **User identity is awkward**: "about me" vs "about this code" is a false dichotomy — everything is connected
- **Dedup is bolted on**: keyword overlap detection is a workaround for not having real relationships
- **Contextual retrieval is keyword-matching**: no semantic understanding of how knowledge relates

A graph model subsumes all of these. Every feature we discussed (topics, tags, dedup, preferences, contradictions, branch scoping, cross-repo sharing) becomes a natural property of nodes and edges.

### Core Model

**Nodes** = knowledge entries (what we currently call "entries")
- Each node has: id, title, content, confidence, trust, created, lastAccessed
- Nodes have labels (formerly "topics"): architecture, convention, gotcha, preference, user, module, recent-work
- Labels are just edges to label nodes — not hardcoded categories

**Edges** = typed, weighted, directional relationships
- Types: `uses`, `prefers`, `is_a`, `works_on`, `gotcha_for`, `contradicts`, `supersedes`, `related_to`, `requires`, `part_of`
- Weight: 0.0–1.0, strengthened by access, weakened by time
- Direction: some directional (Etienne → uses → Kotlin), some bidirectional (MVI ↔ related_to ↔ Reducers)

### Example Graph

```
[Etienne] ──is_a──→ [Sr Android Engineer]
    │                        │
    │works_at                │role_at
    ▼                        ▼
[Zillow]                 [Android Team]
    │                        │
    │owns                    │owns
    ▼                        ▼
[Android Repo]           [iOS Repo]
    │                        │
    │uses                    │uses
    ▼                        ▼
[Kotlin] ◄──prefers── [Etienne]  [Swift]
    │                                │
    │convention                      │convention
    ▼                                ▼
[Real Prefix]                    [protocol-oriented]
[Sealed Interfaces]
[Result<T> over exceptions]

[Etienne] ──prefers──→ [No Emojis]
[Etienne] ──prefers──→ [Concise Communication]
[Etienne] ──prefers──→ [Composition over Inheritance]

[MVI Pattern] ──part_of──→ [Android Repo Architecture]
    │
    │includes
    ▼
[Standalone Reducers] ──gotcha_for──→ [Clean Build After Tuist]
```

### Activation Spreading (Query Algorithm)

When the agent asks for context about "writing a Kotlin reducer for messaging":

1. **Seed**: extract keywords → activate nodes: `Kotlin`, `reducer`, `messaging`
2. **Spread (hop 1)**: follow edges from seed nodes, multiply activation by edge weight
   - Kotlin → `sealed interfaces` (0.9), `Real prefix` (0.8), `Result<T>` (0.85)
   - Reducer → `MVI pattern` (0.95), `standalone reducers` (0.9), `@Inject` (0.8)
   - Messaging → `FlowCoordinator` (0.9), `messaging module gotchas` (0.7)
3. **Spread (hop 2)**: follow edges from hop-1 nodes with dampened activation
   - MVI pattern → `clean build gotcha` (0.6), `pure reduce function` (0.7)
4. **Collect**: sort all activated nodes by final activation score, return top N
5. **Always include**: user identity nodes (connected to everything via `is_a`/`prefers`)

Complexity: O(V + E) per query, trivial for <1000 nodes. No embeddings needed.

### Storage Format

Hybrid: Markdown for content (human-readable), JSON for graph structure (fast traversal).

```
.git/memory/
  nodes/
    node-3f7a2b1c.md          # Human-readable entry content
    node-e8d4f012.md
    ...
  graph.json                    # Adjacency list: {nodeId: [{target, type, weight, created}]}
```

`graph.json`:
```json
{
  "node-3f7a": [
    {"target": "node-e8d4", "type": "related_to", "weight": 0.8, "created": "2026-02-18T..."},
    {"target": "node-5c9b", "type": "prefers", "weight": 0.95, "created": "2026-02-18T..."}
  ],
  "node-e8d4": [
    {"target": "node-3f7a", "type": "related_to", "weight": 0.8, "created": "2026-02-18T..."}
  ]
}
```

Concurrent write safety: `graph.json` is the one shared file that needs care. Options:
- File-level lock (flock) before write
- Append-only edge log + periodic compaction
- CRDTs (overkill for v2, consider for v3)

### Edge Formation

Three sources:
1. **Explicit**: agent calls `memory_connect(from, to, type, weight)` — new tool
2. **Implicit co-occurrence**: entries stored in the same session or referencing the same files get weak `related_to` edges
3. **Keyword-inferred**: entries sharing significant keywords get auto-connected (Jaccard-based weight)

### Migration Path from v1

Backward-compatible transition:
- Every existing entry → a node (same Markdown file, renamed to `nodes/` dir)
- Topic membership → edges: `entry --labeled--> "architecture"` (weight 1.0)
- Keyword overlap between existing entries → `related_to` edges (Jaccard weight)
- User/preference entries → connected to a `[user]` identity node
- Branch tags on recent-work → edges to branch nodes

### Tools (v2)

| Tool | Description |
|------|-------------|
| `memory_store` | Create a node (entry). Auto-creates edges from keyword overlap. |
| `memory_connect` | Create/update an edge between two nodes. |
| `memory_context` | Spreading activation from natural language context. Returns ranked nodes. |
| `memory_query` | Direct node lookup by label/filter (backward compat with v1 topics). |
| `memory_briefing` | Session start — walks graph from user node outward. |
| `memory_correct` | Update a node. Adjusts edge weights to corrected node. |
| `memory_stats` | Graph health: node count, edge count, connectivity, orphan nodes. |
| `memory_bootstrap` | Scan repo, create nodes + auto-edges from file structure. |

### Key Design Decisions

- **No embeddings in v2**: keyword extraction + graph traversal is sufficient for <1000 nodes. Embeddings are v3 if scale demands it.
- **No external DB**: graph.json + Markdown nodes. Fully local, human-inspectable.
- **Edge weight decay**: edges lose weight over time (configurable half-life). Prevents stale connections from dominating.
- **Contradiction detection**: `contradicts` edge type. When the agent stores something that conflicts with a preference, the system can flag it via edge analysis rather than keyword heuristics.

### Open Questions for v2

1. **Graph visualization**: should `memory_stats` output a DOT graph for debugging?
2. **Merging graphs**: when two worktrees have different edges to the same nodes, how to reconcile?
3. **Edge confidence**: should edges have their own trust levels, or inherit from their nodes?
4. **Subgraph extraction**: for briefings, walk N hops from user node — but what's the right N?

---

## Counters

- Next DT ID: DT-068
