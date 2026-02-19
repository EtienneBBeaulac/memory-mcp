# Memory MCP

A Model Context Protocol (MCP) server that gives AI coding agents persistent, evolving knowledge about a codebase. Instead of starting cold every session, agents can store and retrieve observations about architecture, conventions, gotchas, and recent work context.

## Tools

| Tool | Description |
|------|-------------|
| `memory_list_lobes` | List all configured memory lobes (knowledge scopes per repo) with paths and usage stats |
| `memory_store` | Store a knowledge entry with dedup detection and preference surfacing |
| `memory_query` | Query knowledge by scope with brief/standard/full detail levels |
| `memory_context` | Get relevant knowledge for a task (natural language context search with topic boosting) |
| `memory_briefing` | Get a session-start briefing (user > preferences > gotchas > architecture > ...) |
| `memory_correct` | Correct, update, or delete an existing entry (suggests storing as preference) |
| `memory_stats` | View health stats: entries, trust breakdown, freshness, storage usage |
| `memory_bootstrap` | First-use scan to seed knowledge from repo structure, README, and build files |
| `memory_diagnose` | Health check: server status, per-lobe health, crash history, and recovery steps |

## Knowledge Topics

| Topic | Purpose | Expires? | Default Trust |
|-------|---------|----------|---------------|
| `user` | Personal info (name, role, communication style) | Never | `user` |
| `preferences` | Corrections, opinions, coding rules | Never | `user` |
| `gotchas` | Pitfalls and known issues | Never | `user` |
| `architecture` | System design, patterns, module structure | 30 days | `agent-inferred` |
| `conventions` | Code style, naming, patterns | 30 days | `agent-inferred` |
| `modules/<name>` | Per-module knowledge | 30 days | `agent-inferred` |
| `recent-work` | Current task context (branch-scoped) | 7 days | `agent-inferred` |

### Smart Surfacing

- **Dedup detection**: When you store an entry, the response shows similar existing entries in the same topic (>40% keyword overlap) with consolidation instructions
- **Preference surfacing**: Storing a non-preference entry shows relevant preferences that might conflict
- **Piggyback hints**: `memory_correct` suggests storing corrections as reusable preferences
- **`memory_context`**: Describe your task in natural language and get ranked results across all topics with topic-based boosting (preferences 1.8x, gotchas 1.5x)

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Configuration

### Config File (Recommended)

Create a `memory-config.json` file next to the memory MCP server:

```json
{
  "lobes": {
    "workspace-mcp": {
      "root": "$HOME/git/personal/workspace-mcp",
      "budgetMB": 2
    },
    "workrail": {
      "root": "$HOME/git/personal/workrail",
      "budgetMB": 2
    }
  }
}
```

> **Note:** `memoryDir` is optional. When omitted, storage auto-detects to `.git/memory/` for git repos.

**What's a "lobe"?** Each repository gets its own memory lobe — a dedicated knowledge scope. Think of it like brain regions: the "workrail lobe" stores knowledge about workrail, the "workspace-mcp lobe" stores knowledge about workspace-mcp.

**Benefits:**
- Portable (`$HOME` and `~` expansion works across machines)
- Versioned (checked into git)
- Discoverable (use `memory_list_lobes` to see what's configured)
- Easy to extend (just add a new lobe entry)

### Environment Variables (Fallback)

If no `memory-config.json` is found, the server falls back to environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_MCP_WORKSPACES` | — | JSON mapping workspace names to repo paths (multi-repo mode) |
| `MEMORY_MCP_REPO_ROOT` | `process.cwd()` | Fallback: single-repo path (if `WORKSPACES` not set) |
| `MEMORY_MCP_DIR` | *(auto-detect)* | Override storage dir (relative to repo root, or absolute). Disables git-native auto-detection. |
| `MEMORY_MCP_BUDGET` | `2097152` (2MB) | Storage budget per workspace in bytes |

### Adding a New Lobe

1. **Edit `memory-config.json`** (create if it doesn't exist)
2. **Add lobe entry:**
   ```json
   "my-project": {
     "root": "$HOME/git/my-project",
     "budgetMB": 2
   }
   ```
3. **Restart the memory MCP server**
4. **Verify:** Use `memory_list_lobes` to confirm it loaded

The agent will see the new lobe in tool descriptions and can immediately use it with `memory_store(lobe: "my-project", ...)`.

## Firebender Registration

With `memory-config.json` (recommended):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp/dist/index.js"]
    }
  }
}
```

The server reads `memory-config.json` automatically — no env vars needed.

### Legacy: Environment Variable Mode

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp/dist/index.js"],
      "env": {
        "MEMORY_MCP_WORKSPACES": "{\"android\":\"/path/to/android\",\"ios\":\"/path/to/ios\"}"
      }
    }
  }
}
```

## Storage Location

Knowledge is stored as human-readable Markdown files — **one file per entry**. The storage location is **auto-detected** with the following priority:

1. **Explicit `memoryDir` config** — if set in `memory-config.json` or `MEMORY_MCP_DIR`, uses that path
2. **Git-native** (default) — `<git-common-dir>/memory/` using `git rev-parse --git-common-dir`. This ensures:
   - **Invisible to git** — `.git/` contents are never tracked, no `.gitignore` needed
   - **Shared across worktrees** — all worktrees of the same repo share one memory store
   - **Worktree/submodule safe** — resolves to the common `.git/` directory regardless
3. **Central fallback** — `~/.memory-mcp/<lobe-name>/` for non-git directories

Use `memory_stats` or `memory_list_lobes` to see where memory is stored for each lobe.

### File Structure

Each entry gets its own file. Recent-work entries are scoped by branch.

```
.git/memory/
  user/
    user-3f7a2b1c.md              # Personal info
  preferences/
    pref-5c9b7e3d.md              # Coding opinions & corrections
  architecture/
    arch-e8d4f012.md              # One entry per file
  conventions/
    conv-a1b2c3d4.md
  gotchas/
    gotcha-7k3m9p2q.md
  recent-work/
    main/                          # Branch-scoped
      recent-f5e6d7c8.md
    feature-messaging-refactor/    # Sanitized branch name
      recent-9i0j1k2l.md
  modules/
    messaging/
      mod-4d5e6f7g.md
```

### Concurrency Safety

Each entry is its own file with a random hex ID. Two MCP processes (e.g., Firebender + Cursor) writing different entries to the same repo **never conflict** — they write to different files. The store reloads from disk before every read to pick up changes from other processes.

### Branch-Scoped Recent Work

Recent-work entries are automatically tagged with the current git branch and stored in a branch-named subdirectory. `memory_briefing` and `memory_query` filter recent-work to the current branch by default. Use `branch: "*"` to see recent-work from all branches.

### Entry Format

```markdown
# Build System & Language
- **id**: arch-3f7a2b1c
- **topic**: architecture
- **confidence**: 0.70
- **trust**: agent-inferred
- **created**: 2026-02-18T12:00:00.000Z
- **lastAccessed**: 2026-02-18T12:00:00.000Z

Detected: Node.js/TypeScript project (npm)
```

## Trust Levels

| Level | Confidence | Meaning |
|-------|-----------|---------|
| `user` | 1.0 | Human-provided or human-corrected knowledge |
| `agent-confirmed` | 0.85 | Agent-observed and verified against code |
| `agent-inferred` | 0.70 | Agent-observed, not yet verified |

## Design

See `ideas/codebase-memory-mcp-design-thinking.md` for the full design thinking document with 67 ideas, 5 concept packages, pre-mortem analysis, and test plan.
