// Configuration loading for the memory MCP server.
//
// Priority: memory-config.json → env vars → single-repo default
// Graceful degradation: each source falls through to the next on failure.

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import type { MemoryConfig, BehaviorConfig } from './types.js';
import { DEFAULT_STORAGE_BUDGET_BYTES } from './types.js';
import {
  DEFAULT_STALE_DAYS_STANDARD,
  DEFAULT_STALE_DAYS_PREFERENCES,
  DEFAULT_MAX_STALE_IN_BRIEFING,
  DEFAULT_MAX_DEDUP_SUGGESTIONS,
  DEFAULT_MAX_CONFLICT_PAIRS,
} from './thresholds.js';

/** How the config was loaded — discriminated union so configFilePath
 *  only exists when source is 'file' (illegal states unrepresentable) */
export type ConfigOrigin =
  | { readonly source: 'file'; readonly path: string }
  | { readonly source: 'env' }
  | { readonly source: 'default' };

/** Result of loading lobe configs */
export interface LoadedConfig {
  readonly configs: ReadonlyMap<string, MemoryConfig>;
  readonly origin: ConfigOrigin;
  /** Resolved behavior config — present when a "behavior" block was found in memory-config.json */
  readonly behavior?: BehaviorConfig;
}

interface MemoryConfigFileBehavior {
  staleDaysStandard?: number;
  staleDaysPreferences?: number;
  maxStaleInBriefing?: number;
  maxDedupSuggestions?: number;
  maxConflictPairs?: number;
}

interface MemoryConfigFile {
  lobes: Record<string, {
    root: string;
    memoryDir?: string;
    budgetMB?: number;
  }>;
  /** Optional global behavior overrides applied to all lobes */
  behavior?: MemoryConfigFileBehavior;
}

/** Validate and clamp a numeric threshold to a given range.
 *  Returns the default if the value is missing, NaN, or out of range. */
function clampThreshold(value: unknown, defaultValue: number, min: number, max: number): number {
  if (value === undefined || value === null) return defaultValue;
  const n = Number(value);
  if (isNaN(n) || n < min || n > max) {
    process.stderr.write(`[memory-mcp] Behavior threshold out of range [${min}, ${max}]: ${value} — using default ${defaultValue}\n`);
    return defaultValue;
  }
  return Math.round(n); // integer thresholds only
}

/** Known behavior config keys — used to warn on typos/unknown fields at startup. */
const KNOWN_BEHAVIOR_KEYS = new Set<string>([
  'staleDaysStandard', 'staleDaysPreferences',
  'maxStaleInBriefing', 'maxDedupSuggestions', 'maxConflictPairs',
]);

/** Parse and validate a behavior config block, falling back to defaults for each field.
 *  Warns to stderr for unknown keys (likely typos) and out-of-range values.
 *  Exported for testing — validates and clamps all fields. */
export function parseBehaviorConfig(raw?: MemoryConfigFileBehavior): BehaviorConfig {
  if (!raw) return {};

  // Warn on unrecognized keys so typos don't silently produce defaults
  for (const key of Object.keys(raw)) {
    if (!KNOWN_BEHAVIOR_KEYS.has(key)) {
      process.stderr.write(
        `[memory-mcp] Unknown behavior config key "${key}" — ignored. ` +
        `Valid keys: ${Array.from(KNOWN_BEHAVIOR_KEYS).join(', ')}\n`
      );
    }
  }

  return {
    staleDaysStandard: clampThreshold(raw.staleDaysStandard, DEFAULT_STALE_DAYS_STANDARD, 1, 365),
    staleDaysPreferences: clampThreshold(raw.staleDaysPreferences, DEFAULT_STALE_DAYS_PREFERENCES, 1, 730),
    maxStaleInBriefing: clampThreshold(raw.maxStaleInBriefing, DEFAULT_MAX_STALE_IN_BRIEFING, 1, 20),
    maxDedupSuggestions: clampThreshold(raw.maxDedupSuggestions, DEFAULT_MAX_DEDUP_SUGGESTIONS, 1, 10),
    maxConflictPairs: clampThreshold(raw.maxConflictPairs, DEFAULT_MAX_CONFLICT_PAIRS, 1, 5),
  };
}

function resolveRoot(root: string): string {
  return root
    .replace(/^\$HOME\b/, process.env.HOME ?? '')
    .replace(/^~/, process.env.HOME ?? '');
}

/**
 * Resolve the memory storage directory for a workspace.
 *
 * Priority:
 * 1. Explicit memoryDir config -> use it (relative to repoRoot, or absolute)
 * 2. Git repo detected -> `<git-common-dir>/memory/` — shared across all worktrees
 * 3. Fallback -> `~/.memory-mcp/<workspaceName>/` (central, no git pollution)
 *
 * Uses `git rev-parse --git-common-dir` which always resolves to the main
 * .git/ directory regardless of whether you're in a linked worktree or
 * submodule. This ensures all worktrees of the same repo share one memory.
 */
function resolveMemoryPath(repoRoot: string, workspaceName: string, explicitMemoryDir?: string): string {
  if (explicitMemoryDir) {
    if (path.isAbsolute(explicitMemoryDir)) {
      return explicitMemoryDir;
    }
    return path.join(repoRoot, explicitMemoryDir);
  }

  // Use git to find the common .git directory (shared across worktrees)
  try {
    const result = execFileSync(
      'git', ['rev-parse', '--git-common-dir'],
      { cwd: repoRoot, encoding: 'utf-8', timeout: 5000 }
    ).trim();

    const gitCommonDir = path.resolve(repoRoot, result);
    return path.join(gitCommonDir, 'memory');
  } catch {
    // Not a git repo or git not available — fall through to central store
  }

  return path.join(os.homedir(), '.memory-mcp', workspaceName);
}

/** Load lobe configs with priority: memory-config.json -> env vars -> single-repo default */
export function getLobeConfigs(): LoadedConfig {
  const configs = new Map<string, MemoryConfig>();

  // 1. Try loading from memory-config.json (highest priority)
  const configPath = path.resolve(
    new URL('.', import.meta.url).pathname,
    '..',
    'memory-config.json'
  );

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const external: MemoryConfigFile = JSON.parse(raw);

    if (!external.lobes || typeof external.lobes !== 'object') {
      process.stderr.write(`[memory-mcp] Invalid memory-config.json: missing "lobes" object\n`);
    } else {
      // Parse global behavior config once — applies to all lobes
      const behavior = parseBehaviorConfig(external.behavior);

      for (const [name, config] of Object.entries(external.lobes)) {
        if (!config.root) {
          process.stderr.write(`[memory-mcp] Skipping lobe "${name}": missing "root" field\n`);
          continue;
        }
        const repoRoot = resolveRoot(config.root);
        configs.set(name, {
          repoRoot,
          memoryPath: resolveMemoryPath(repoRoot, name, config.memoryDir),
          storageBudgetBytes: (config.budgetMB ?? 2) * 1024 * 1024,
          behavior,
        });
      }

      if (configs.size > 0) {
        process.stderr.write(`[memory-mcp] Loaded ${configs.size} lobe(s) from memory-config.json\n`);
        // Pass resolved behavior at the top-level so diagnostics can surface active values
        const resolvedBehavior = external.behavior ? parseBehaviorConfig(external.behavior) : undefined;
        return { configs, origin: { source: 'file', path: configPath }, behavior: resolvedBehavior };
      }
    }
  } catch (error: unknown) {
    // ENOENT = config file doesn't exist, which is expected — silently fall through
    const isFileNotFound = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isFileNotFound) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[memory-mcp] Failed to parse memory-config.json: ${message}\n`);
    }
  }

  // 2. Try env var multi-repo mode
  const workspacesJson = process.env.MEMORY_MCP_WORKSPACES;
  if (workspacesJson) {
    const explicitDir = process.env.MEMORY_MCP_DIR;
    const storageBudget = parseInt(process.env.MEMORY_MCP_BUDGET ?? '', 10) || DEFAULT_STORAGE_BUDGET_BYTES;

    try {
      const parsed = JSON.parse(workspacesJson) as Record<string, string>;
      for (const [name, rawRoot] of Object.entries(parsed)) {
        const repoRoot = resolveRoot(rawRoot);
        configs.set(name, {
          repoRoot,
          memoryPath: resolveMemoryPath(repoRoot, name, explicitDir),
          storageBudgetBytes: storageBudget,
        });
      }
      if (configs.size > 0) {
        process.stderr.write(`[memory-mcp] Loaded ${configs.size} lobe(s) from MEMORY_MCP_WORKSPACES env var\n`);
        return { configs, origin: { source: 'env' } };
      }
    } catch (e) {
      process.stderr.write(`[memory-mcp] Failed to parse MEMORY_MCP_WORKSPACES: ${e}\n`);
    }
  }

  // 3. Fall back to single-repo default
  const repoRoot = process.env.MEMORY_MCP_REPO_ROOT ?? process.cwd();
  const explicitDir = process.env.MEMORY_MCP_DIR;
  const storageBudget = parseInt(process.env.MEMORY_MCP_BUDGET ?? '', 10) || DEFAULT_STORAGE_BUDGET_BYTES;

  configs.set('default', {
    repoRoot,
    memoryPath: resolveMemoryPath(repoRoot, 'default', explicitDir),
    storageBudgetBytes: storageBudget,
  });
  process.stderr.write(`[memory-mcp] Using single-lobe default mode (cwd: ${repoRoot})\n`);

  return { configs, origin: { source: 'default' } };
}
