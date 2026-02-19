# Memory MCP Storage Location - Ideation Results

## Problem Summary
The memory MCP currently stores `.memory/` inside each repo root, which pollutes `git status` and forces users to add `.memory/` to every repo's `.gitignore`. With multiple workspaces this becomes annoying fast. We need a better default storage location strategy.

## Constraints
- Must support N workspaces simultaneously with isolated knowledge
- Human-readable Markdown files (non-negotiable)
- Must survive across sessions (persistent)
- Should not require per-repo git configuration
- Must be inspectable/editable by humans
- 2MB budget per workspace
- Should work across macOS and Linux

## Perspective
Storage location — optimizing for zero-friction git cleanliness while preserving discoverability.

## Ideas Generated: 9 (refined to top 3)

---

### Idea 1: Git-Native — `.git/memory/` (RECOMMENDED)

**Core Concept:**
Store memory inside the repo's own `.git/` directory. The `.git/` directory is invisible to git by definition — nothing inside it shows up in `git status`, `git diff`, or `git add`. This is the only location that is both co-located with the repo AND inherently git-invisible.

**How It Works:**
1. On store init, resolve the workspace root's `.git` entry
2. If `.git` is a directory → use `.git/memory/` directly
3. If `.git` is a file (worktree/submodule) → read the `gitdir:` pointer and follow it
4. If no `.git` exists → fall back to central store (Idea 2)
5. All Markdown knowledge files go under the resolved `.git/memory/` path

**Pros:**
- Zero git pollution by definition — `.git/` contents are never tracked
- Co-located with the repo — `ls .git/memory/` works from repo root
- No configuration needed for git repos
- Survives branch switches (`.git/` is branch-independent)
- Lost on fresh clone — correct behavior (each clone builds its own knowledge)
- No new dotdirs in home directory

**Cons:**
- Worktrees and submodules need special handling (`.git` is a file, not a dir)
- Non-git repos need a fallback
- `.git/` is considered "sacred" by some — unconventional to add custom dirs
- Lost on `git clone` / `git worktree add` (can be pro or con)

**Implementation Complexity:** Low-Medium
Core path is trivial (just change dir). Worktree/submodule resolution adds ~20 lines.

**Example:**
```typescript
function resolveMemoryDir(repoRoot: string): string {
  const gitPath = path.join(repoRoot, '.git');
  const stat = fs.statSync(gitPath, { throwIfNoEntry: false });
  
  if (stat?.isDirectory()) {
    return path.join(gitPath, 'memory');
  }
  
  if (stat?.isFile()) {
    // Worktree or submodule: .git is a file containing "gitdir: <path>"
    const content = fs.readFileSync(gitPath, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (match) {
      const gitDir = path.resolve(repoRoot, match[1]);
      return path.join(gitDir, 'memory');
    }
  }
  
  // Fallback: central store
  return path.join(os.homedir(), '.memory-mcp', path.basename(repoRoot));
}
```

---

### Idea 2: Smart Default Central — `~/.memory-mcp/<workspace-name>/` (FALLBACK)

**Core Concept:**
Store all memory under a central dotdir in the user's home directory, keyed by workspace name. This is the universal fallback that works regardless of whether the workspace is a git repo. Users who want in-repo storage can override via config.

**How It Works:**
1. Default memory dir: `~/.memory-mcp/<workspace-name>/`
2. Workspace name comes from `MEMORY_MCP_WORKSPACES` config (e.g., `"android"`, `"ios"`)
3. Override per-workspace via config: `{"android": {"root": "/path", "memoryDir": "/custom/path"}}`
4. Override globally via `MEMORY_MCP_DIR` env var for single-workspace mode

**Pros:**
- Works for any directory (not just git repos)
- Clean, predictable location
- Workspace names as directory names = human-readable
- Power users can override to in-repo
- No git pollution

**Cons:**
- Not co-located with the repo (harder to discover)
- New dotdir in home directory
- Must know to look in `~/.memory-mcp/` to find/edit knowledge

**Implementation Complexity:** Low

**Example:**
```
~/.memory-mcp/
  android/
    architecture.md
    conventions.md
    gotchas.md
  ios/
    architecture.md
    modules/
      messaging.md
  workspace-mcp/
    architecture.md
```

---

### Idea 3: Firebender-Adjacent — `~/.firebender/memory/<workspace-name>/`

**Core Concept:**
Store memory alongside the existing Firebender configuration, since the memory MCP is primarily used through Firebender.

**How It Works:**
1. Memory dir: `~/.firebender/memory/<workspace-name>/`
2. Co-located with MCP config in `~/.firebender/firebender.json`

**Pros:**
- User already knows about `~/.firebender/`
- Discoverable — everything tool-related is in one place
- Clean workspace names as directories

**Cons:**
- Couples memory to Firebender specifically
- If another MCP host (Cursor, Claude Code) uses memory-mcp, data ends up in firebender's dir
- Firebender may change its config location in the future

**Implementation Complexity:** Low

---

### Filtered Out

| Idea | Why Filtered |
|------|-------------|
| XDG Home (`~/.local/share/`) | Hash-based dirs are opaque; macOS doesn't natively use XDG |
| Global Gitignore auto-config | Too invasive — modifies user's git config without consent |
| Sidecar (sibling dir) | Pollutes parent directory with visible `.memory-*` dirs |
| Symlink Bridge | Over-engineered; Windows incompatible |
| Git-Remote-Keyed | Too fragile (no remote = broken); better for v2 |
| Hybrid Manifest | Two locations to manage adds complexity without proportional benefit |

---

## Recommendation: Git-Native with Central Fallback

**Use `.git/memory/` when the workspace is a git repo. Fall back to `~/.memory-mcp/<name>/` for non-git repos.**

This gives:
- **Zero git pollution** — by definition, not by configuration
- **Co-located with code** — discoverable via `ls .git/memory/`
- **No config needed** for the 99% case (git repos)
- **Graceful fallback** for the 1% case (non-git directories)
- **Lost on clone = correct behavior** — each clone builds its own knowledge
- **No new dotdirs** in home for git repos

### Recommended Next Steps
1. Implement `resolveMemoryDir()` with git detection + worktree/submodule handling
2. Update `MarkdownMemoryStore` config to accept resolved memory dir
3. Add `memory_stats` output showing where memory is stored (for discoverability)
4. Document the storage location logic in README
5. Remove `.memory/` from `.gitignore` (no longer needed)
