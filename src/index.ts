#!/usr/bin/env node

// Codebase Memory MCP Server
// Provides persistent, evolving knowledge for AI coding agents
// Supports multiple workspaces simultaneously

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import path from 'path';
import { readFile, writeFile } from 'fs/promises';
import { MarkdownMemoryStore } from './store.js';
import type { DetailLevel, TopicScope, TrustLevel } from './types.js';
import { parseTopicScope, parseTrustLevel } from './types.js';
import type { ScoredEntry } from './ranking.js';
import { getLobeConfigs, type ConfigOrigin } from './config.js';
import { ConfigManager } from './config-manager.js';
import { normalizeArgs } from './normalize.js';
import {
  buildCrashReport, writeCrashReport, writeCrashReportSync, readLatestCrash,
  readCrashHistory, clearLatestCrash, formatCrashReport, formatCrashSummary,
  markServerStarted, type CrashContext, type CrashReport,
} from './crash-journal.js';
import { formatStaleSection, formatConflictWarning, formatStats, formatBehaviorConfigSection, mergeTagFrequencies, buildQueryFooter, buildBriefingTagPrimerSections, formatSearchMode, formatLootDrop } from './formatters.js';
import { parseFilter, extractTitle, type FilterGroup } from './text-analyzer.js';
import { VOCABULARY_ECHO_LIMIT, MAX_FOOTER_TAGS, WARN_SEPARATOR } from './thresholds.js';
import { matchRootsToLobeNames, buildLobeResolution, type LobeResolution, type LobeRootConfig } from './lobe-resolution.js';

// --- Server health state ---
// Tracks the degradation ladder: Running -> Degraded -> SafeMode
// "Errors are data" — health status is a discriminated union, not a boolean flag.

type LobeHealth =
  | { readonly status: 'healthy' }
  | { readonly status: 'degraded'; readonly error: string; readonly since: string; readonly recovery: string[] };

type ServerMode =
  | { readonly kind: 'running' }
  | { readonly kind: 'degraded'; readonly reason: string }
  | { readonly kind: 'safe-mode'; readonly error: string; readonly recovery: string[] };

let serverMode: ServerMode = { kind: 'running' };
const lobeHealth = new Map<string, LobeHealth>();
const serverStartTime = Date.now();

/** Track the last tool call for crash context */
let lastToolCall: string | undefined;

// --- Configuration ---
const { configs: lobeConfigs, origin: configOrigin, behavior: configBehavior } = getLobeConfigs();
const configPath = configOrigin.source === 'file' ? configOrigin.path : '';

/** Build crash context from current server state */
function currentCrashContext(phase: CrashContext['phase']): CrashContext {
  return {
    phase,
    lastToolCall,
    configSource: configManager.getConfigOrigin().source,
    lobeCount: configManager.getLobeNames().length,
  };
}

// --- Process-level crash protection ---
// Philosophy: fail fast with meaningful error messages.
// On uncaught exception: journal the crash to disk, then die.
// The crash journal persists so the NEXT startup can report what happened.
// Never zombie — unknown state is worse than no state.

process.on('uncaughtException', (error) => {
  process.stderr.write(`[memory-mcp] FATAL: Uncaught exception — journaling and exiting.\n`);
  process.stderr.write(`[memory-mcp] Error: ${error.message}\n`);
  if (error.stack) process.stderr.write(`[memory-mcp] Stack: ${error.stack}\n`);

  const report = buildCrashReport(error, 'uncaught-exception', currentCrashContext('running'));
  const filepath = writeCrashReportSync(report);
  if (filepath) {
    process.stderr.write(`[memory-mcp] Crash report saved: ${filepath}\n`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  process.stderr.write(`[memory-mcp] FATAL: Unhandled rejection — journaling and exiting.\n`);
  process.stderr.write(`[memory-mcp] Error: ${error.message}\n`);
  if (error.stack) process.stderr.write(`[memory-mcp] Stack: ${error.stack}\n`);

  const report = buildCrashReport(error, 'unhandled-rejection', currentCrashContext('running'));
  const filepath = writeCrashReportSync(report);
  if (filepath) {
    process.stderr.write(`[memory-mcp] Crash report saved: ${filepath}\n`);
  }
  process.exit(1);
});

// --- Server setup ---
const stores = new Map<string, MarkdownMemoryStore>();
const lobeNames = Array.from(lobeConfigs.keys());

// ConfigManager will be initialized after stores are set up
let configManager: ConfigManager;

/** Topics that auto-route to the first alwaysInclude lobe when no lobe is specified on writes.
 *  This is a backwards-compat shim — agents historically wrote these without specifying a lobe. */
const ALWAYS_INCLUDE_WRITE_TOPICS: ReadonlySet<TopicScope> = new Set<TopicScope>(['user', 'preferences']);

/** Resolved tool context — after resolution, the raw lobe string is inaccessible.
 *  This eliminates the entire class of bugs where handlers accidentally use
 *  the unresolved lobe input instead of the resolved one. */
type ToolContext =
  | { readonly ok: true; readonly store: MarkdownMemoryStore; readonly label: string }
  | { readonly ok: false; readonly error: string };

/** Resolve a raw lobe name to a validated store + display label.
 *  After this call, consumers use ctx.label — the raw lobe is not in scope. */
function resolveToolContext(rawLobe: string | undefined): ToolContext {
  const lobeNames = configManager.getLobeNames();

  // Default to single lobe when omitted
  const lobe = rawLobe || (lobeNames.length === 1 ? lobeNames[0] : undefined);
  if (!lobe) {
    return { ok: false, error: `Lobe is required. Available: ${lobeNames.join(', ')}` };
  }

  // Check if lobe is degraded
  const health = configManager.getLobeHealth(lobe);
  if (health?.status === 'degraded') {
    return {
      ok: false,
      error: `Lobe "${lobe}" is degraded: ${health.error}\n\n` +
        `Recovery steps:\n${health.recovery.map(s => `- ${s}`).join('\n')}\n\n` +
        `Use memory_diagnose for full diagnostics.`,
    };
  }

  const store = configManager.getStore(lobe);
  if (!store) {
    const available = lobeNames.join(', ');

    const configOrigin = configManager.getConfigOrigin();
    let hint = '';
    if (configOrigin.source === 'file') {
      hint = `\n\nTo add lobe "${lobe}", either:\n` +
             `A) Call memory_bootstrap(lobe: "${lobe}", root: "/absolute/path/to/repo") — auto-adds it in one step.\n` +
             `B) Edit ${configOrigin.path}, add: "${lobe}": { "root": "/absolute/path/to/repo", "budgetMB": 2 }, then retry (no restart needed — the server hot-reloads automatically).`;
    } else if (configOrigin.source === 'env') {
      hint = `\n\nTo add lobe "${lobe}", update MEMORY_MCP_WORKSPACES env var or create memory-config.json`;
    } else {
      hint = `\n\nTo add lobes, create memory-config.json next to the memory MCP server with lobe definitions.`;
    }

    return { ok: false, error: `Unknown lobe: "${lobe}". Available: ${available}${hint}` };
  }
  return { ok: true, store, label: lobe };
}

/** Helper to return an MCP error response from a failed context resolution */
function contextError(ctx: ToolContext & { ok: false }) {
  return {
    content: [{ type: 'text' as const, text: ctx.error }],
    isError: true as const,
  };
}

/** Infer lobe from file paths by matching against known repo roots.
 *  Returns the lobe name if exactly one lobe matches, undefined otherwise.
 *  Ambiguous matches (multiple lobes) return undefined — better to ask than guess wrong. */
function inferLobeFromPaths(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;

  const lobeNames = configManager.getLobeNames();
  const matchedLobes = new Set<string>();

  for (const filePath of paths) {
    // Resolve path to absolute for matching
    const resolved = path.isAbsolute(filePath) ? filePath : filePath;
    for (const lobeName of lobeNames) {
      const config = configManager.getLobeConfig(lobeName);
      if (!config) continue;
      // Check if the file path starts with or is inside the repo root
      if (resolved.startsWith(config.repoRoot) || resolved.startsWith(path.basename(config.repoRoot))) {
        matchedLobes.add(lobeName);
      }
    }
  }

  // Only return if unambiguous — exactly one lobe matched
  return matchedLobes.size === 1 ? matchedLobes.values().next().value : undefined;
}

const server = new Server(
  { name: 'memory-mcp', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// --- Lobe resolution for read operations ---
// When the agent doesn't specify a lobe, we determine which lobe(s) to search
// via a degradation ladder (see lobe-resolution.ts for the pure logic):
//   1. Single lobe configured → use it (unambiguous)
//   2. Multiple lobes → ask client for workspace roots via MCP roots/list
//   3. Fallback → global-only with a hint to specify the lobe

/** Resolve which lobes to search for a read operation when the agent omitted the lobe param.
 *  Wires the MCP server's listRoots into the pure resolution logic. */
async function resolveLobesForRead(isFirstMemoryToolCall: boolean = true): Promise<LobeResolution> {
  const allLobeNames = configManager.getLobeNames();
  const alwaysIncludeLobes = configManager.getAlwaysIncludeLobes();

  // Short-circuit: single lobe is unambiguous — no need for root matching.
  // Handles both plain single-lobe and single-lobe-that-is-alwaysInclude cases.
  if (allLobeNames.length === 1) {
    return buildLobeResolution(allLobeNames, allLobeNames, alwaysIncludeLobes, isFirstMemoryToolCall);
  }

  // Multiple lobes — try MCP client roots
  const clientCaps = server.getClientCapabilities();
  if (clientCaps?.roots) {
    try {
      const { roots } = await server.listRoots();
      if (roots && roots.length > 0) {
        const lobeConfigs: LobeRootConfig[] = allLobeNames
          .map(name => {
            const config = configManager.getLobeConfig(name);
            return config ? { name, repoRoot: config.repoRoot } : undefined;
          })
          .filter((c): c is LobeRootConfig => c !== undefined);

        const matched = matchRootsToLobeNames(roots, lobeConfigs);
        return buildLobeResolution(allLobeNames, matched, alwaysIncludeLobes, isFirstMemoryToolCall);
      }
    } catch (err) {
      process.stderr.write(`[memory-mcp] listRoots failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Fallback — roots not available or no match
  return buildLobeResolution(allLobeNames, [], alwaysIncludeLobes, isFirstMemoryToolCall);
}

/** Build the shared lobe property for tool schemas — called on each ListTools request
 *  so the description and enum stay in sync after a hot-reload adds or removes lobes. */
function buildLobeProperty(currentLobeNames: readonly string[]) {
  const isSingle = currentLobeNames.length === 1;
  return {
    type: 'string' as const,
    description: isSingle
      ? `Memory lobe name (defaults to "${currentLobeNames[0]}" if omitted)`
      : `Memory lobe name. When omitted for reads, the server uses the client's workspace roots to select the matching lobe. If roots are unavailable and no alwaysInclude lobes are configured, specify a lobe explicitly to access lobe-specific knowledge. Required for writes. Available: ${currentLobeNames.join(', ')}`,
    enum: currentLobeNames.length > 1 ? [...currentLobeNames] : undefined,
  };
}

/** Helper to format config file path for display */
function configFileDisplay(): string {
  const origin = configManager.getConfigOrigin();
  return origin.source === 'file' ? origin.path : '(not using config file)';
}

// --- Tool definitions ---
// Handler is async so it can call configManager.ensureFresh() and return a fresh
// lobe list. This ensures the enum and descriptions stay correct after hot-reload.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await configManager.ensureFresh();
  const currentLobeNames = configManager.getLobeNames();
  const lobeProperty = buildLobeProperty(currentLobeNames);

  return { tools: [
    // ─── New v2 tool surface ─────────────────────────────────────────────
    // 4 retrieval tools + 4 storage tools + 1 maintenance tool.
    // Old tools (memory_store, memory_query, memory_correct, memory_context) are hidden
    // from listing but their handlers remain active for backward compatibility.

    // --- Retrieval ---
    {
      name: 'brief',
      description: 'Session start. Returns user identity, preferences, gotchas overview, stale entries. Call once at the beginning of a conversation. Example: brief(lobe: "android")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
        },
        required: [],
      },
    },
    {
      name: 'recall',
      description: 'Pre-task lookup. Describe what you are about to do and get relevant knowledge (semantic + keyword search). Example: recall(lobe: "android", context: "writing a Kotlin reducer for the messaging feature")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          context: {
            type: 'string',
            description: 'What you are about to do, in natural language.',
          },
          maxResults: {
            type: 'number',
            description: 'Max results (default: 10)',
            default: 10,
          },
        },
        required: ['context'],
      },
    },
    {
      name: 'gotchas',
      description: 'Get stored gotchas for a codebase area. Example: gotchas(lobe: "android", area: "auth")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          area: {
            type: 'string',
            description: 'Optional keyword filter for a specific area (e.g. "auth", "build", "navigation").',
          },
        },
        required: [],
      },
    },
    {
      name: 'conventions',
      description: 'Get stored conventions for a codebase area. Example: conventions(lobe: "android", area: "testing")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          area: {
            type: 'string',
            description: 'Optional keyword filter for a specific area (e.g. "testing", "naming", "architecture").',
          },
        },
        required: [],
      },
    },

    // --- Storage ---
    {
      name: 'gotcha',
      description: 'Store a gotcha — a pitfall, surprising behavior, or trap. Write naturally; title is auto-extracted. Example: gotcha(lobe: "android", observation: "Gradle cache must be cleaned after Tuist changes or builds silently use stale artifacts")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          observation: {
            type: 'string',
            description: 'The gotcha — write naturally. First sentence becomes the title.',
          },
          durabilityDecision: {
            type: 'string',
            enum: ['default', 'store-anyway'],
            description: 'Use "store-anyway" only when re-storing after a review-required response.',
            default: 'default',
          },
        },
        required: ['lobe', 'observation'],
      },
    },
    {
      name: 'convention',
      description: 'Store a convention — a pattern, rule, or standard the codebase follows. Example: convention(lobe: "android", observation: "All ViewModels use StateFlow for UI state. LiveData is banned.")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          observation: {
            type: 'string',
            description: 'The convention — write naturally. First sentence becomes the title.',
          },
          durabilityDecision: {
            type: 'string',
            enum: ['default', 'store-anyway'],
            description: 'Use "store-anyway" only when re-storing after a review-required response.',
            default: 'default',
          },
        },
        required: ['lobe', 'observation'],
      },
    },
    {
      name: 'learn',
      description: 'Store a general observation — architecture decisions, dependency info, or any insight. Example: learn(lobe: "android", observation: "The messaging feature uses MVVM with a FlowCoordinator for navigation state")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          observation: {
            type: 'string',
            description: 'The observation — write naturally. First sentence becomes the title.',
          },
          durabilityDecision: {
            type: 'string',
            enum: ['default', 'store-anyway'],
            description: 'Use "store-anyway" only when re-storing after a review-required response.',
            default: 'default',
          },
        },
        required: ['lobe', 'observation'],
      },
    },
    {
      name: 'prefer',
      description: 'Store a user preference or working style rule. Stored with high trust. Example: prefer(rule: "Always suggest the simplest solution first")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          rule: {
            type: 'string',
            description: 'The preference or rule — write naturally.',
          },
          lobe: {
            ...lobeProperty,
            description: `Optional. Lobe to scope this preference to. Omit for global preferences. Available: ${currentLobeNames.join(', ')}`,
          },
        },
        required: ['rule'],
      },
    },

    // --- Maintenance ---
    {
      name: 'fix',
      description: 'Fix or delete an entry. With correction: replaces content. Without: deletes. Example: fix(id: "gotcha-3f7a", correction: "updated text") or fix(id: "gotcha-3f7a")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'Entry ID (e.g. gotcha-3f7a, arch-5c9b).',
          },
          correction: {
            type: 'string',
            description: 'New text. Omit to delete the entry.',
          },
          lobe: {
            ...lobeProperty,
            description: `Optional. Searches all lobes if omitted. Available: ${currentLobeNames.join(', ')}`,
          },
        },
        required: ['id'],
      },
    },

    // --- Legacy tools (still listed for backward compatibility) ---
    // memory_store, memory_query, memory_correct, memory_context handlers remain active
    // but are hidden from tool discovery. Agents use the new v2 tools above.
    {
      name: 'memory_bootstrap',
      description: 'First-time setup: scan repo structure, README, and build system to seed initial knowledge. Run once per new codebase. If the lobe does not exist yet, provide "root" to auto-add it to memory-config.json and proceed without a manual restart.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: {
            type: 'string' as const,
            description: `Memory lobe name. If the lobe doesn't exist yet, also pass "root" to auto-create it. Available lobes: ${currentLobeNames.join(', ')}`,
          },
          root: {
            type: 'string' as const,
            description: 'Absolute path to the repo root. Required only when the lobe does not exist yet — the server will add it to memory-config.json automatically.',
          },
          budgetMB: {
            type: 'number' as const,
            description: 'Storage budget in MB for the new lobe (default: 2). Only used when auto-creating a lobe via "root".',
          },
        },
        required: [],
      },
    },
    // Hidden tools — handlers still active:
    // memory_stats, memory_diagnose, memory_reembed, memory_list_lobes,
    // memory_store, memory_query, memory_correct, memory_context
  ] };
});

// --- MCP Resource: memory://lobes ---
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  await configManager.ensureFresh();
  return {
    resources: [{
      uri: 'memory://lobes',
      name: 'Available memory lobes',
      description: 'Lists all configured memory lobes with their health status and entry counts.',
      mimeType: 'application/json',
    }],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (uri === 'memory://lobes') {
    await configManager.ensureFresh();
    const lobeInfo = await buildLobeInfo();
    return {
      contents: [{
        uri: 'memory://lobes',
        mimeType: 'application/json',
        text: JSON.stringify({ lobes: lobeInfo }, null, 2),
      }],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// --- Tool handlers ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  lastToolCall = name; // track for crash context
  const args = normalizeArgs(name, rawArgs as Record<string, unknown> | undefined, lobeNames);

  // In safe mode, only memory_diagnose and memory_list_lobes work
  if (serverMode.kind === 'safe-mode' && name !== 'memory_diagnose' && name !== 'memory_list_lobes') {
    return {
      content: [{
        type: 'text',
        text: [
          `## ⚠ Memory MCP is in Safe Mode`,
          ``,
          `**Reason:** ${serverMode.error}`,
          ``,
          `The server is alive but cannot serve knowledge. Available tools in safe mode:`,
          `- **memory_diagnose** — see crash details and recovery steps`,
          `- **memory_list_lobes** — see server configuration`,
          ``,
          `### Recovery Steps`,
          ...serverMode.recovery.map(s => `- ${s}`),
        ].join('\n'),
      }],
      isError: true,
    };
  }

  try {
    // Ensure config is fresh before handling any tool
    await configManager.ensureFresh();

    switch (name) {
      case 'memory_list_lobes': {
        // Delegates to shared builder — same data as memory://lobes resource
        const lobeInfo = await buildLobeInfo();
        const alwaysIncludeNames = configManager.getAlwaysIncludeLobes();
        const result = {
          serverMode: serverMode.kind,
          lobes: lobeInfo,
          alwaysIncludeLobes: alwaysIncludeNames,
          configFile: configFileDisplay(),
          configSource: configOrigin.source,
          totalLobes: lobeInfo.length,
          degradedLobes: lobeInfo.filter((l: { health: string }) => l.health === 'degraded').length,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // ─── New v2 tool handlers ────────────────────────────────────────────

      // Shared helper for gotcha/convention/learn — identical store logic, different topic.
      case 'gotcha':
      case 'convention':
      case 'learn': {
        const topicMap: Record<string, import('./types.js').TopicScope> = {
          gotcha: 'gotchas', convention: 'conventions', learn: 'general',
        };
        const topic = topicMap[name];
        const { lobe: rawLobe, observation, durabilityDecision } = z.object({
          lobe: z.string().min(1),
          observation: z.string().min(1),
          durabilityDecision: z.enum(['default', 'store-anyway']).default('default'),
        }).parse(args);

        process.stderr.write(`[memory-mcp] tool=${name} lobe=${rawLobe}\n`);

        const ctx = resolveToolContext(rawLobe);
        if (!ctx.ok) return contextError(ctx);

        const { title, content } = extractTitle(observation);
        const result = await ctx.store.store(topic, title, content, [], 'agent-inferred', [], [], durabilityDecision);

        if (result.kind === 'review-required') {
          return {
            content: [{ type: 'text', text: `[${ctx.label}] Review required: ${result.warning}\n\nIf intentional, re-run: ${name}(lobe: "${rawLobe}", observation: "...", durabilityDecision: "store-anyway")` }],
            isError: true,
          };
        }
        if (result.kind === 'rejected') {
          return {
            content: [{ type: 'text', text: `[${ctx.label}] Failed: ${result.warning}` }],
            isError: true,
          };
        }

        const lootDrop = result.relatedEntries ? formatLootDrop(result.relatedEntries) : '';
        const label = name === 'learn' ? '' : `${name} `;
        return {
          content: [{ type: 'text', text: `[${ctx.label}] Stored ${label}${result.id}: "${title}" (confidence: ${result.confidence})${lootDrop}` }],
        };
      }

      case 'brief': {
        // Session-start briefing — user identity, preferences, gotchas overview, stale entries.
        // Delegates to the same briefing logic as memory_context(context: undefined).
        const { lobe: rawLobe } = z.object({
          lobe: z.string().optional(),
        }).parse(args ?? {});

        process.stderr.write(`[memory-mcp] tool=brief lobe=${rawLobe ?? 'auto'}\n`);

        // Surface previous crash report
        const previousCrash = await readLatestCrash();
        const crashSection = previousCrash
          ? `## Previous Crash Detected\n${formatCrashSummary(previousCrash)}\nRun **memory_diagnose** for full details.\n`
          : '';
        if (previousCrash) await clearLatestCrash();

        // Surface degraded lobes warning
        const allBriefingLobes = rawLobe
          ? [rawLobe, ...configManager.getAlwaysIncludeLobes().filter(n => n !== rawLobe)]
          : configManager.getLobeNames();
        const degradedLobeNames = allBriefingLobes.filter(n => configManager.getLobeHealth(n)?.status === 'degraded');
        const degradedSection = degradedLobeNames.length > 0
          ? `## Degraded Lobes: ${degradedLobeNames.join(', ')}\nRun **memory_diagnose** for details.`
          : '';

        const sections: string[] = [];
        if (crashSection) sections.push(crashSection);
        if (degradedSection) sections.push(degradedSection);

        // Collect briefing across all lobes (or specified lobe + alwaysInclude)
        const briefingLobeNames = allBriefingLobes;
        const allStale: import('./types.js').StaleEntry[] = [];
        let totalEntries = 0;
        const alwaysIncludeSet = new Set(configManager.getAlwaysIncludeLobes());

        for (const lobeName of briefingLobeNames) {
          const health = configManager.getLobeHealth(lobeName);
          if (health?.status === 'degraded') continue;
          const store = configManager.getStore(lobeName);
          if (!store) continue;
          const budget = alwaysIncludeSet.has(lobeName) ? 300 : 100;
          const lobeBriefing = await store.briefing(budget);
          if (lobeBriefing.entryCount > 0) sections.push(lobeBriefing.briefing);
          if (lobeBriefing.staleDetails) allStale.push(...lobeBriefing.staleDetails);
          totalEntries += lobeBriefing.entryCount;
        }

        if (allStale.length > 0) sections.push(formatStaleSection(allStale));

        if (sections.length === 0) {
          sections.push('No knowledge stored yet. As you work, use **gotcha**, **convention**, or **learn** to store observations. Try **memory_bootstrap** to seed initial knowledge.');
        }

        const briefLobes = briefingLobeNames.filter(n => configManager.getLobeHealth(n)?.status !== 'degraded');
        sections.push(`---\n*${totalEntries} entries across ${briefLobes.length} ${briefLobes.length === 1 ? 'lobe' : 'lobes'}. Use **recall(context: "what you are doing")** for task-specific knowledge.*`);

        return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] };
      }

      case 'recall': {
        // Pre-task lookup — semantic + keyword search on the target lobe.
        // Pure task-relevant search — no global preferences (that's what brief is for).
        const { lobe: rawLobe, context, maxResults } = z.object({
          lobe: z.string().optional(),
          context: z.string().min(1),
          maxResults: z.number().optional(),
        }).parse(args);

        process.stderr.write(`[memory-mcp] tool=recall lobe=${rawLobe ?? 'auto'} context="${context.slice(0, 50)}"\n`);

        const max = maxResults ?? 10;
        const allLobeResults: ScoredEntry[] = [];
        const ctxEntryLobeMap = new Map<string, string>();
        let label: string;
        let primaryStore: MarkdownMemoryStore | undefined;

        if (rawLobe) {
          const ctx = resolveToolContext(rawLobe);
          if (!ctx.ok) return contextError(ctx);
          label = ctx.label;
          primaryStore = ctx.store;
          const lobeResults = await ctx.store.contextSearch(context, max);
          allLobeResults.push(...lobeResults);
        } else {
          // Search all non-global lobes (recall is task-specific, not identity)
          const resolution = await resolveLobesForRead(false);
          switch (resolution.kind) {
            case 'resolved': {
              label = resolution.label;
              for (const lobeName of resolution.lobes) {
                const store = configManager.getStore(lobeName);
                if (!store) continue;
                if (!primaryStore) primaryStore = store;
                const lobeResults = await store.contextSearch(context, max);
                if (resolution.lobes.length > 1) {
                  for (const r of lobeResults) ctxEntryLobeMap.set(r.entry.id, lobeName);
                }
                allLobeResults.push(...lobeResults);
              }
              break;
            }
            case 'global-only': {
              // No project lobes matched — ask agent to specify
              return {
                content: [{ type: 'text', text: `Cannot determine which lobe to search. Specify the lobe: recall(lobe: "...", context: "${context}")\nAvailable: ${configManager.getLobeNames().join(', ')}` }],
                isError: true,
              };
            }
          }
        }

        // Dedupe, sort, slice
        const seenIds = new Set<string>();
        const results = allLobeResults
          .sort((a, b) => b.score - a.score)
          .filter(r => {
            if (seenIds.has(r.entry.id)) return false;
            seenIds.add(r.entry.id);
            return true;
          })
          .slice(0, max);

        if (results.length === 0) {
          const modeHint = primaryStore
            ? `\n${formatSearchMode(primaryStore.hasEmbedder, primaryStore.vectorCount, primaryStore.entryCount)}`
            : '';
          return {
            content: [{
              type: 'text',
              text: `No relevant knowledge found for: "${context}"\n\nProceed without prior context. Use **gotcha**, **convention**, or **learn** to store observations as you work.${modeHint}`,
            }],
          };
        }

        // Format results grouped by topic
        const sections: string[] = [`## Recall: "${context}"\n`];
        const byTopic = new Map<string, typeof results>();
        for (const r of results) {
          const list = byTopic.get(r.entry.topic) ?? [];
          list.push(r);
          byTopic.set(r.entry.topic, list);
        }

        const topicOrder = ['gotchas', 'conventions', 'architecture', 'general'];
        const orderedTopics = [
          ...topicOrder.filter(t => byTopic.has(t)),
          ...Array.from(byTopic.keys()).filter(t => !topicOrder.includes(t)).sort(),
        ];

        const showLobeLabels = ctxEntryLobeMap.size > 0;
        for (const topic of orderedTopics) {
          const topicResults = byTopic.get(topic)!;
          const heading = topic === 'gotchas' ? 'Gotchas'
            : topic === 'conventions' ? 'Conventions'
            : topic === 'general' ? 'General'
            : topic.startsWith('modules/') ? `Module: ${topic.split('/')[1]}`
            : topic.charAt(0).toUpperCase() + topic.slice(1);

          sections.push(`### ${heading}`);
          for (const r of topicResults) {
            const marker = topic === 'gotchas' ? '[!] ' : '';
            const lobeLabel = showLobeLabels ? ` [${ctxEntryLobeMap.get(r.entry.id) ?? '?'}]` : '';
            sections.push(`- **${marker}${r.entry.title}**${lobeLabel}: ${r.entry.content}`);
          }
          sections.push('');
        }

        // Mode indicator
        if (primaryStore) {
          sections.push(formatSearchMode(primaryStore.hasEmbedder, primaryStore.vectorCount, primaryStore.entryCount));
        }

        return { content: [{ type: 'text', text: sections.join('\n') }] };
      }

      case 'gotchas': {
        // Topic-filtered query for gotchas.
        const { lobe: rawLobe, area } = z.object({
          lobe: z.string().optional(),
          area: z.string().optional(),
        }).parse(args ?? {});

        process.stderr.write(`[memory-mcp] tool=gotchas lobe=${rawLobe ?? 'auto'} area=${area ?? '*'}\n`);

        const ctx = resolveToolContext(rawLobe);
        if (!ctx.ok) return contextError(ctx);

        const result = await ctx.store.query('gotchas', 'standard', area);
        if (result.entries.length === 0) {
          return {
            content: [{ type: 'text', text: `[${ctx.label}] No gotchas found${area ? ` for "${area}"` : ''}. Use **gotcha(lobe, observation)** to store one.` }],
          };
        }

        const lines = result.entries.map(e =>
          `- **[!] ${e.title}** (${e.id}): ${e.content}`
        );
        return {
          content: [{ type: 'text', text: `## [${ctx.label}] Gotchas${area ? ` — ${area}` : ''}\n\n${lines.join('\n')}` }],
        };
      }

      case 'conventions': {
        // Topic-filtered query for conventions.
        const { lobe: rawLobe, area } = z.object({
          lobe: z.string().optional(),
          area: z.string().optional(),
        }).parse(args ?? {});

        process.stderr.write(`[memory-mcp] tool=conventions lobe=${rawLobe ?? 'auto'} area=${area ?? '*'}\n`);

        const ctx = resolveToolContext(rawLobe);
        if (!ctx.ok) return contextError(ctx);

        const result = await ctx.store.query('conventions', 'standard', area);
        if (result.entries.length === 0) {
          return {
            content: [{ type: 'text', text: `[${ctx.label}] No conventions found${area ? ` for "${area}"` : ''}. Use **convention(lobe, observation)** to store one.` }],
          };
        }

        const lines = result.entries.map(e =>
          `- **${e.title}** (${e.id}): ${e.content}`
        );
        return {
          content: [{ type: 'text', text: `## [${ctx.label}] Conventions${area ? ` — ${area}` : ''}\n\n${lines.join('\n')}` }],
        };
      }

      case 'prefer': {
        // Store a user preference. Routes to alwaysInclude lobe (or specified lobe).
        const { rule, lobe: rawLobe } = z.object({
          rule: z.string().min(1),
          lobe: z.string().optional(),
        }).parse(args);

        process.stderr.write(`[memory-mcp] tool=prefer lobe=${rawLobe ?? 'global'}\n`);

        // Route to alwaysInclude lobe when no lobe specified
        let effectiveLobe = rawLobe;
        if (!effectiveLobe) {
          const alwaysIncludeLobes = configManager.getAlwaysIncludeLobes();
          effectiveLobe = alwaysIncludeLobes.length > 0 ? alwaysIncludeLobes[0] : undefined;
        }

        const ctx = resolveToolContext(effectiveLobe);
        if (!ctx.ok) {
          return {
            content: [{ type: 'text', text: `No global lobe configured for preferences. Specify a lobe: prefer(rule: "...", lobe: "...").\nAvailable: ${configManager.getLobeNames().join(', ')}` }],
            isError: true,
          };
        }

        const { title, content } = extractTitle(rule);
        const result = await ctx.store.store('preferences', title, content, [], 'user');

        if (result.kind !== 'stored') {
          return {
            content: [{ type: 'text', text: `[${ctx.label}] Failed to store preference: ${result.kind === 'review-required' ? result.warning : result.kind === 'rejected' ? result.warning : 'unknown error'}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: `[${ctx.label}] Stored preference ${result.id}: "${title}" (trust: user)` }],
        };
      }

      case 'fix': {
        // Fix or delete an entry. Search all stores if no lobe specified.
        const { id, correction, lobe: rawLobe } = z.object({
          id: z.string().min(1),
          correction: z.string().optional(),
          lobe: z.string().optional(),
        }).parse(args);

        process.stderr.write(`[memory-mcp] tool=fix id=${id} action=${correction ? 'replace' : 'delete'}\n`);

        const action = correction !== undefined && correction.length > 0 ? 'replace' : 'delete';

        // Resolve lobe — search all stores if not specified
        let effectiveFixLobe = rawLobe;
        let foundInLobe: string | undefined;
        if (!effectiveFixLobe) {
          for (const lobeName of configManager.getLobeNames()) {
            const store = configManager.getStore(lobeName);
            if (!store) continue;
            try {
              if (await store.hasEntry(id)) {
                effectiveFixLobe = lobeName;
                foundInLobe = lobeName;
                break;
              }
            } catch {
              // Skip degraded lobes
            }
          }
        }

        if (!effectiveFixLobe) {
          return {
            content: [{ type: 'text', text: `Entry "${id}" not found in any lobe. Available: ${configManager.getLobeNames().join(', ')}` }],
            isError: true,
          };
        }

        const ctx = resolveToolContext(effectiveFixLobe);
        if (!ctx.ok) return contextError(ctx);

        const result = await ctx.store.correct(id, correction ?? '', action);
        if (!result.corrected) {
          return {
            content: [{ type: 'text', text: `[${ctx.label}] Failed: ${result.error}` }],
            isError: true,
          };
        }

        const lobeNote = foundInLobe && !rawLobe ? ` (found in lobe: ${foundInLobe})` : '';
        if (action === 'delete') {
          return {
            content: [{ type: 'text', text: `Deleted entry ${id}${lobeNote}.` }],
          };
        }
        return {
          content: [{ type: 'text', text: `Fixed entry ${id}${lobeNote} (confidence: ${result.newConfidence}, trust: ${result.trust}).` }],
        };
      }

      // ─── Legacy tool handlers (hidden from listing) ──────────────────────

      case 'memory_store': {
        const { lobe: rawLobe, topic: rawTopic, entries: rawEntries, sources, references, trust: rawTrust, tags: rawTags, durabilityDecision } = z.object({
          lobe: z.string().optional(),
          topic: z.string(),
          // Accept a bare {title, fact} object in addition to the canonical array form.
          // Only objects are auto-wrapped — strings and other primitives still fail with
          // a type error, preserving the "validate at boundaries" invariant.
          entries: z.preprocess(
            (val) => (val !== null && !Array.isArray(val) && typeof val === 'object' ? [val] : val),
            z.array(z.object({
              title: z.string().min(1),
              fact: z.string().min(1),
            })).min(1),
          ),
          sources: z.array(z.string()).default([]),
          references: z.array(z.string()).default([]),
          trust: z.enum(['user', 'agent-confirmed', 'agent-inferred']).default('agent-inferred'),
          tags: z.array(z.string()).default([]),
          durabilityDecision: z.enum(['default', 'store-anyway']).default('default'),
        }).parse(args);

        // Validate topic at boundary
        const topic = parseTopicScope(rawTopic);
        if (!topic) {
          return {
            content: [{ type: 'text', text: `Invalid topic: "${rawTopic}". Valid: user | preferences | architecture | conventions | gotchas | general | recent-work | modules/<name>` }],
            isError: true,
          };
        }

        // Trust is already validated by Zod enum, but use our parser for consistency
        const trust = parseTrustLevel(rawTrust) ?? 'agent-inferred';

        // Auto-detect lobe from file paths when lobe is omitted and multiple lobes exist
        let effectiveLobe = rawLobe;
        if (!effectiveLobe && configManager.getLobeNames().length > 1) {
          const allPaths = [...sources, ...references];
          effectiveLobe = inferLobeFromPaths(allPaths);
        }

        // Auto-route user/preferences writes to the first alwaysInclude lobe when no lobe specified.
        // This preserves the previous behavior where these topics auto-routed to the global store.
        if (!effectiveLobe && ALWAYS_INCLUDE_WRITE_TOPICS.has(topic)) {
          const alwaysIncludeLobes = configManager.getAlwaysIncludeLobes();
          if (alwaysIncludeLobes.length > 0) {
            effectiveLobe = alwaysIncludeLobes[0];
          }
        }

        // Resolve store — after this point, rawLobe is never used again
        const ctx = resolveToolContext(effectiveLobe);
        if (!ctx.ok) return contextError(ctx);

        // Auto-promote trust for global topics: agents writing user/preferences without explicit
        // trust: "user" still get full confidence. Preserves pre-unification behavior where the
        // global store always stored these at user trust — removing this would silently downgrade
        // identity entries to confidence 0.70 (see philosophy: "Observability as a constraint").
        const effectiveTrust = ALWAYS_INCLUDE_WRITE_TOPICS.has(topic) && trust === 'agent-inferred'
          ? 'user' as TrustLevel
          : trust;

        // Store each entry and collect results — typed to the success branch only
        // (early return above handles the failure case, so only stored:true entries reach the array)
        type StoreSuccess = Extract<Awaited<ReturnType<typeof ctx.store.store>>, { kind: 'stored' }>;
        const storedResults: Array<{ title: string; result: StoreSuccess }> = [];
        for (const { title, fact } of rawEntries) {
          const result = await ctx.store.store(topic, title, fact, sources, effectiveTrust, references, rawTags, durabilityDecision);
          if (result.kind === 'review-required') {
            const lines = [
              `[${ctx.label}] Review required before storing "${title}".`,
              '',
              `Severity: ${result.severity}`,
              'Signals:',
              ...result.signals.map(signal => `- ${signal.label}: ${signal.detail}`),
              '',
              result.warning,
              '',
              'If this knowledge is still worth persisting, re-run with:',
              `memory_store(topic: "${topic}", entries: [{title: "${title}", fact: "${fact.replace(/"/g, '\\"')}"}], trust: "${effectiveTrust}", durabilityDecision: "store-anyway"${rawTags.length > 0 ? `, tags: ${JSON.stringify(rawTags)}` : ''}${sources.length > 0 ? `, sources: ${JSON.stringify(sources)}` : ''}${references.length > 0 ? `, references: ${JSON.stringify(references)}` : ''})`,
            ];
            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              isError: true,
            };
          }
          if (result.kind === 'rejected') {
            return {
              content: [{ type: 'text', text: `[${ctx.label}] Failed to store "${title}": ${result.warning}` }],
              isError: true,
            };
          }
          storedResults.push({ title, result });
        }

        // Build response header.
        // For high-severity ephemeral detections, flag the success line itself so agents
        // who anchor on line 1 still see the problem before reading the block below.
        const lines: string[] = [];
        if (storedResults.length === 1) {
          const { result } = storedResults[0];
          const ephemeralFlag = result.ephemeralSeverity === 'high' ? ' (⚠ ephemeral — see below)' : '';
          lines.push(`[${ctx.label}] Stored entry ${result.id} in ${result.topic} (confidence: ${result.confidence})${ephemeralFlag}`);
          if (result.warning) lines.push(`Note: ${result.warning}`);
        } else {
          const { result: first } = storedResults[0];
          lines.push(`[${ctx.label}] Stored ${storedResults.length} entries in ${first.topic} (confidence: ${first.confidence}):`);
          for (const { title, result } of storedResults) {
            const ephemeralFlag = result.ephemeralSeverity === 'high' ? ' ⚠' : '';
            lines.push(`  - ${result.id}: "${title}"${ephemeralFlag}`);
          }
        }

        // Limit to at most 2 hint sections per response to prevent hint fatigue.
        // Priority: dedup > ephemeral > preferences (dedup is actionable and high-signal,
        // ephemeral warnings affect entry quality, preferences are informational).
        // For multi-entry batches, hints reference the first triggering entry.
        let hintCount = 0;

        for (const { title, result } of storedResults) {
          const entryPrefix = storedResults.length > 1 ? `"${title}": ` : '';

          // Dedup: surface related entries in the same topic.
          // Fill in both actual IDs so the agent can act immediately without looking them up.
          if (result.relatedEntries && result.relatedEntries.length > 0 && hintCount < 2) {
            hintCount++;
            const top = result.relatedEntries[0];
            lines.push('');
            lines.push(WARN_SEPARATOR);
            lines.push(`⚠  ${entryPrefix}SIMILAR ENTRY ALREADY EXISTS — CONSOLIDATE  ⚠`);
            lines.push(WARN_SEPARATOR);
            lines.push(`  ${top.id}: "${top.title}" (confidence: ${top.confidence})`);
            lines.push(`  ${top.content.length > 120 ? top.content.substring(0, 120) + '...' : top.content}`);
            if (result.relatedEntries.length > 1) {
              const extra = result.relatedEntries.length - 1;
              lines.push(`  ... and ${extra} more similar ${extra === 1 ? 'entry' : 'entries'}`);
            }
            lines.push('');
            lines.push('If these overlap, consolidate:');
            lines.push(`  KEEP+UPDATE: memory_correct(id: "${top.id}", action: "replace", correction: "<merged content>")`);
            lines.push(`  DELETE new:  memory_correct(id: "${result.id}", action: "delete")`);
            lines.push(WARN_SEPARATOR);
          }

          // Ephemeral content warning — the formatted block already contains visual borders
          // and pre-filled delete command from formatEphemeralWarning.
          if (result.ephemeralWarning && hintCount < 2) {
            hintCount++;
            lines.push('');
            if (entryPrefix) lines.push(`${entryPrefix}:`);
            lines.push(result.ephemeralWarning);
          }

          // Preference surfacing: show relevant preferences for non-preference entries
          if (result.relevantPreferences && result.relevantPreferences.length > 0 && hintCount < 2) {
            hintCount++;
            lines.push('');
            lines.push(`📌 ${entryPrefix}Relevant preferences:`);
            for (const p of result.relevantPreferences) {
              lines.push(`  - [pref] ${p.title}: ${p.content.length > 120 ? p.content.substring(0, 120) + '...' : p.content}`);
            }
            lines.push('');
            lines.push('Review the stored entry against these preferences for potential conflicts.');
          }
        }

        // Vocabulary echo: show existing tags to drive convergence (once per response)
        if (hintCount < 2) {
          const tagFreq = ctx.store.getTagFrequency();
          if (tagFreq.size > 0) {
            hintCount++;
            const topTags = [...tagFreq.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, VOCABULARY_ECHO_LIMIT)
              .map(([tag, count]) => `${tag}(${count})`).join(', ');
            const truncated = tagFreq.size > VOCABULARY_ECHO_LIMIT ? ` (top ${VOCABULARY_ECHO_LIMIT} shown)` : '';
            lines.push('');
            lines.push(`Existing tags: ${topTags}${truncated}. Reuse for consistency. Query with filter: "#tag".`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'memory_query': {
        const { lobe: rawLobe, scope, detail, filter, branch, isFirstMemoryToolCall: rawIsFirst } = z.object({
          lobe: z.string().optional(),
          scope: z.string().default('*'),
          detail: z.enum(['brief', 'standard', 'full']).default('brief'),
          filter: z.string().optional(),
          branch: z.string().optional(),
          isFirstMemoryToolCall: z.boolean().default(true),
        }).parse(args ?? {});

        // Force-include alwaysInclude lobes when querying a global topic (user/preferences),
        // regardless of isFirstMemoryToolCall — the agent explicitly asked for this data.
        // Philosophy: "Determinism over cleverness" — same query produces same results.
        const topicScope = parseTopicScope(scope);
        const effectiveIsFirst = rawIsFirst || (topicScope !== null && ALWAYS_INCLUDE_WRITE_TOPICS.has(topicScope));

        // Resolve which lobes to search — unified path for all topics.
        let lobeEntries: import('./types.js').QueryEntry[] = [];
        const entryLobeMap = new Map<string, string>(); // entry id → lobe name
        let label: string;
        let primaryStore: MarkdownMemoryStore | undefined;
        let queryGlobalOnlyHint: string | undefined;

        if (rawLobe) {
          const ctx = resolveToolContext(rawLobe);
          if (!ctx.ok) return contextError(ctx);
          label = ctx.label;
          primaryStore = ctx.store;
          const result = await ctx.store.query(scope, detail as DetailLevel, filter, branch);
          lobeEntries = [...result.entries];
        } else {
          const resolution = await resolveLobesForRead(effectiveIsFirst);
          switch (resolution.kind) {
            case 'resolved': {
              label = resolution.label;
              for (const lobeName of resolution.lobes) {
                const store = configManager.getStore(lobeName);
                if (!store) continue;
                if (!primaryStore) primaryStore = store;
                const result = await store.query(scope, detail as DetailLevel, filter, branch);
                if (resolution.lobes.length > 1) {
                  for (const e of result.entries) entryLobeMap.set(e.id, lobeName);
                }
                lobeEntries.push(...result.entries);
              }
              break;
            }
            case 'global-only': {
              label = 'global';
              queryGlobalOnlyHint = resolution.hint;
              break;
            }
          }
        }

        // Dedupe by id, sort by relevance score
        const seenQueryIds = new Set<string>();
        const allEntries = lobeEntries
          .filter(e => {
            if (seenQueryIds.has(e.id)) return false;
            seenQueryIds.add(e.id);
            return true;
          })
          .sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Build stores collection for tag frequency aggregation
        const searchedStores: MarkdownMemoryStore[] = [];
        if (primaryStore) searchedStores.push(primaryStore);
        const tagFreq = mergeTagFrequencies(searchedStores);

        // Parse filter once for both filtering (already done) and footer display
        const filterGroups = filter ? parseFilter(filter) : [];

        if (allEntries.length === 0) {
          const footer = buildQueryFooter({ filterGroups, rawFilter: filter, tagFreq, resultCount: 0, scope });
          const noResultHint = queryGlobalOnlyHint ? `\n\n> ${queryGlobalOnlyHint}` : '';
          return {
            content: [{
              type: 'text',
              text: `[${label}] No entries found for scope "${scope}"${filter ? ` with filter "${filter}"` : ''}.${noResultHint}\n\n---\n${footer}`,
            }],
          };
        }

        const showQueryLobeLabels = entryLobeMap.size > 0;
        const lines = allEntries.map(e => {
          const freshIndicator = e.fresh ? '' : ' [stale]';
          const lobeTag = showQueryLobeLabels ? ` [${entryLobeMap.get(e.id) ?? '?'}]` : '';
          if (detail === 'brief') {
            return `- **${e.title}** (${e.id}${lobeTag}, confidence: ${e.confidence})${freshIndicator}\n  ${e.summary}`;
          }
          if (detail === 'full') {
            const meta = [
              `ID: ${e.id}`,
              showQueryLobeLabels ? `Lobe: ${entryLobeMap.get(e.id) ?? '?'}` : null,
              `Confidence: ${e.confidence}`,
              `Trust: ${e.trust}`,
              `Fresh: ${e.fresh}`,
              e.sources?.length ? `Sources: ${e.sources.join(', ')}` : null,
              e.references?.length ? `References: ${e.references.join(', ')}` : null,
              e.tags?.length ? `Tags: ${e.tags.join(', ')}` : null,
              `Created: ${e.created}`,
              `Last accessed: ${e.lastAccessed}`,
              e.gitSha ? `Git SHA: ${e.gitSha}` : null,
            ].filter(Boolean).join('\n');
            return `### ${e.title}\n${meta}\n\n${e.content}`;
          }
          if (detail === 'standard') {
            const metaParts: string[] = [];
            if (e.references?.length) metaParts.push(`References: ${e.references.join(', ')}`);
            if (e.tags?.length) metaParts.push(`Tags: ${e.tags.join(', ')}`);
            const metaLine = metaParts.length > 0 ? `\n${metaParts.join('\n')}\n` : '\n';
            return `### ${e.title}\n*${e.id}${lobeTag} | confidence: ${e.confidence}${freshIndicator}*${metaLine}\n${e.summary}`;
          }
          return `### ${e.title}\n*${e.id}${lobeTag} | confidence: ${e.confidence}${freshIndicator}*\n\n${e.summary}`;
        });

        const totalCount = allEntries.length;
        let text = `## [${label}] Query: ${scope} (${totalCount} entries)\n\n${lines.join('\n\n')}`;

        // Conflict detection: compare entry pairs in the result set.
        if (primaryStore) {
          const rawEntries = primaryStore.getEntriesByIds(allEntries.map(e => e.id));
          const conflicts = primaryStore.detectConflicts(rawEntries);
          if (conflicts.length > 0) {
            text += '\n\n' + formatConflictWarning(conflicts);
          }
        }

        // Surface hint when we fell back to global-only
        if (queryGlobalOnlyHint) {
          text += `\n\n> ${queryGlobalOnlyHint}`;
        }

        // Build footer with query mode, tag vocabulary, and syntax reference
        const footer = buildQueryFooter({ filterGroups, rawFilter: filter, tagFreq, resultCount: allEntries.length, scope });
        text += `\n\n---\n${footer}`;

        return { content: [{ type: 'text', text }] };
      }

      case 'memory_correct': {
        const { lobe: rawLobe, id, correction, action } = z.object({
          lobe: z.string().optional(),
          id: z.string().min(1),
          correction: z.string().optional(),
          action: z.enum(['append', 'replace', 'delete']),
        }).parse(args);

        // Replace requires non-empty content; append allows empty string (acts as a timestamp touch
        // to refresh lastAccessed without changing content — useful for stale entry verification)
        if (action === 'replace' && !correction) {
          return {
            content: [{ type: 'text', text: 'Correction text is required for replace action.' }],
            isError: true,
          };
        }
        if (action === 'append' && correction === undefined) {
          return {
            content: [{ type: 'text', text: 'Correction text is required for append action. Use "" to refresh lastAccessed without changing content.' }],
            isError: true,
          };
        }

        // Resolve store — if no lobe specified, probe alwaysInclude lobes first (read-only)
        // to find where user/pref entries live, then apply the correction only to the owning store.
        // Philosophy: "Prefer atomicity for correctness" — never call correct() speculatively.
        let effectiveCorrectLobe = rawLobe;
        if (!effectiveCorrectLobe) {
          const alwaysIncludeLobes = configManager.getAlwaysIncludeLobes();
          for (const lobeName of alwaysIncludeLobes) {
            const store = configManager.getStore(lobeName);
            if (!store) continue;
            try {
              if (await store.hasEntry(id)) {
                effectiveCorrectLobe = lobeName;
                break;
              }
            } catch (err) {
              process.stderr.write(`[memory-mcp] Warning: hasEntry probe failed for lobe "${lobeName}": ${err instanceof Error ? err.message : String(err)}\n`);
            }
          }
        }

        // If we probed alwaysInclude lobes and didn't find the entry, provide a richer error
        // than the generic "Lobe is required" from resolveToolContext.
        if (!effectiveCorrectLobe && !rawLobe) {
          const searchedLobes = configManager.getAlwaysIncludeLobes();
          const allLobes = configManager.getLobeNames();
          const searchedNote = searchedLobes.length > 0
            ? `Searched alwaysInclude lobes (${searchedLobes.join(', ')}) — entry not found. `
            : '';
          return {
            content: [{ type: 'text', text: `Entry "${id}" not found. ${searchedNote}Specify the lobe that contains it. Available: ${allLobes.join(', ')}` }],
            isError: true,
          };
        }

        const ctx = resolveToolContext(effectiveCorrectLobe);
        if (!ctx.ok) return contextError(ctx);

        const result = await ctx.store.correct(id, correction ?? '', action);

        if (!result.corrected) {
          return {
            content: [{ type: 'text', text: `[${ctx.label}] Failed to correct: ${result.error}` }],
            isError: true,
          };
        }

        const lines: string[] = [];
        if (action === 'delete') {
          lines.push(`[${ctx.label}] Deleted entry ${id}.`);
        } else {
          lines.push(`[${ctx.label}] Corrected entry ${id} (action: ${action}, confidence: ${result.newConfidence}, trust: ${result.trust}).`);
          // Piggyback: suggest storing as a preference if the correction seems generalizable
          if (correction && correction.length > 20) {
            lines.push('');
            lines.push('💡 If this correction reflects a general preference or rule (not just a one-time fix),');
            lines.push(`consider: memory_store(topic: "preferences", title: "<short rule>", content: "${correction.length > 60 ? correction.substring(0, 60) + '...' : correction}", trust: "user")`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'memory_context': {
        const { lobe: rawLobe, context, maxResults, minMatch, isFirstMemoryToolCall: rawIsFirst } = z.object({
          lobe: z.string().optional(),
          context: z.string().optional(),
          maxResults: z.number().optional(),
          minMatch: z.number().min(0).max(1).optional(),
          isFirstMemoryToolCall: z.boolean().default(true),
        }).parse(args ?? {});

        // --- Briefing mode: no context provided → user + preferences + stale nudges ---
        if (!context) {
          // Surface previous crash report at the top if one exists
          const previousCrash = await readLatestCrash();
          const crashSection = previousCrash
            ? `## ⚠ Previous Crash Detected\n${formatCrashSummary(previousCrash)}\nRun **memory_diagnose** for full details and recovery steps.\n`
            : '';
          if (previousCrash) await clearLatestCrash();

          // Surface degraded lobes warning
          const allBriefingLobeNames = configManager.getLobeNames();
          const degradedLobeNames = allBriefingLobeNames.filter(n => configManager.getLobeHealth(n)?.status === 'degraded');
          const degradedSection = degradedLobeNames.length > 0
            ? `## ⚠ Degraded Lobes: ${degradedLobeNames.join(', ')}\nRun **memory_diagnose** for details.\n`
            : '';

          const sections: string[] = [];
          if (crashSection) sections.push(crashSection);
          if (degradedSection) sections.push(degradedSection);

          // Collect briefing, stale entries, and entry counts across all lobes
          // (alwaysInclude lobes are in the lobe list — no separate global store query needed)
          const allStale: import('./types.js').StaleEntry[] = [];
          let totalEntries = 0;
          let totalStale = 0;

          // Give alwaysInclude lobes a higher token budget (identity/preferences are high-value)
          const alwaysIncludeSet = new Set(configManager.getAlwaysIncludeLobes());
          for (const lobeName of allBriefingLobeNames) {
            const health = configManager.getLobeHealth(lobeName);
            if (health?.status === 'degraded') continue;
            const store = configManager.getStore(lobeName);
            if (!store) continue;
            const budget = alwaysIncludeSet.has(lobeName) ? 300 : 100;
            const lobeBriefing = await store.briefing(budget);
            if (alwaysIncludeSet.has(lobeName) && lobeBriefing.entryCount > 0) {
              sections.push(lobeBriefing.briefing);
            }
            if (lobeBriefing.staleDetails) allStale.push(...lobeBriefing.staleDetails);
            totalEntries += lobeBriefing.entryCount;
            totalStale += lobeBriefing.staleEntries;
          }

          if (allStale.length > 0) {
            sections.push(formatStaleSection(allStale));
          }

          if (sections.length === 0) {
            sections.push('No knowledge stored yet. As you work, store observations with memory_store. Try memory_bootstrap to seed initial knowledge from the repo.');
          }

          // Tag primer: keep vocabularies lobe-local instead of merging them across lobes.
          const briefingTagPrimers = buildBriefingTagPrimerSections(
            allBriefingLobeNames
              .filter(lobeName => configManager.getLobeHealth(lobeName)?.status !== 'degraded')
              .map((lobeName): readonly [string, ReadonlyMap<string, number>] => {
                const store = configManager.getStore(lobeName);
                return [lobeName, store?.getTagFrequency() ?? new Map<string, number>()] as const;
              })
          );
          if (briefingTagPrimers.length > 0) {
            sections.push(...briefingTagPrimers);
          }

          const briefingHints: string[] = [];
          briefingHints.push(`${totalEntries} entries${totalStale > 0 ? ` (${totalStale} stale)` : ''} across ${allBriefingLobeNames.length} ${allBriefingLobeNames.length === 1 ? 'lobe' : 'lobes'}.`);
          briefingHints.push('Use memory_context(context: "what you are about to do") for task-specific knowledge.');
          if (allBriefingLobeNames.length > 1) {
            briefingHints.push(`Available lobes: ${allBriefingLobeNames.join(', ')}.`);
          }

          let text = sections.join('\n\n---\n\n');
          text += `\n\n---\n*${briefingHints.join(' ')}*`;
          return { content: [{ type: 'text', text }] };
        }

        // --- Search mode: context provided → keyword search across all topics ---
        const max = maxResults ?? 10;
        const threshold = minMatch ?? 0.2;

        // Resolve which lobes to search — follows the degradation ladder via resolveLobesForRead().
        const allLobeResults: ScoredEntry[] = [];
        const ctxEntryLobeMap = new Map<string, string>(); // entry id → lobe name
        let label: string;
        let primaryStore: MarkdownMemoryStore | undefined;
        let ctxGlobalOnlyHint: string | undefined;

        if (rawLobe) {
          const ctx = resolveToolContext(rawLobe);
          if (!ctx.ok) return contextError(ctx);
          label = ctx.label;
          primaryStore = ctx.store;
          const lobeResults = await ctx.store.contextSearch(context, max, undefined, threshold);
          allLobeResults.push(...lobeResults);
        } else {
          const resolution = await resolveLobesForRead(rawIsFirst);
          switch (resolution.kind) {
            case 'resolved': {
              label = resolution.label;
              for (const lobeName of resolution.lobes) {
                const store = configManager.getStore(lobeName);
                if (!store) continue;
                if (!primaryStore) primaryStore = store;
                const lobeResults = await store.contextSearch(context, max, undefined, threshold);
                if (resolution.lobes.length > 1) {
                  for (const r of lobeResults) ctxEntryLobeMap.set(r.entry.id, lobeName);
                }
                allLobeResults.push(...lobeResults);
              }
              break;
            }
            case 'global-only': {
              label = 'global';
              ctxGlobalOnlyHint = resolution.hint;
              break;
            }
          }
        }

        // Dedupe by entry id, re-sort by score, take top N
        const seenIds = new Set<string>();
        const results = allLobeResults
          .sort((a, b) => b.score - a.score)
          .filter(r => {
            if (seenIds.has(r.entry.id)) return false;
            seenIds.add(r.entry.id);
            return true;
          })
          .slice(0, max);

        // Build stores collection for tag frequency aggregation
        const ctxSearchedStores: MarkdownMemoryStore[] = [];
        if (primaryStore) ctxSearchedStores.push(primaryStore);
        const ctxTagFreq = mergeTagFrequencies(ctxSearchedStores);

        // Parse filter for footer (context search has no filter, pass empty)
        const ctxFilterGroups: FilterGroup[] = [];

        if (results.length === 0) {
          const ctxFooter = buildQueryFooter({ filterGroups: ctxFilterGroups, rawFilter: undefined, tagFreq: ctxTagFreq, resultCount: 0, scope: 'context search' });
          const noResultHint = ctxGlobalOnlyHint
            ? `\n\n> ${ctxGlobalOnlyHint}`
            : '\n\nThis is fine — proceed without prior context. As you learn things worth remembering, store them with memory_store.';
          // Mode indicator on no-results path — helps diagnose why nothing was found
          const modeHint = primaryStore
            ? `\n${formatSearchMode(primaryStore.hasEmbedder, primaryStore.vectorCount, primaryStore.entryCount)}`
            : '';
          return {
            content: [{
              type: 'text',
              text: `[${label}] No relevant knowledge found for: "${context}"${noResultHint}${modeHint}\n\n---\n${ctxFooter}`,
            }],
          };
        }

        const sections: string[] = [`## [${label}] Context: "${context}"\n`];

        // Group results by topic for readability
        const byTopic = new Map<string, typeof results>();
        for (const r of results) {
          const list = byTopic.get(r.entry.topic) ?? [];
          list.push(r);
          byTopic.set(r.entry.topic, list);
        }

        // Topic display order
        const topicOrder = ['user', 'preferences', 'gotchas', 'conventions', 'architecture'];
        const orderedTopics = [
          ...topicOrder.filter(t => byTopic.has(t)),
          ...Array.from(byTopic.keys()).filter(t => !topicOrder.includes(t)).sort(),
        ];

        const showCtxLobeLabels = ctxEntryLobeMap.size > 0;
        for (const topic of orderedTopics) {
          const topicResults = byTopic.get(topic)!;
          const heading = topic === 'user' ? 'About You'
            : topic === 'preferences' ? 'Your Preferences'
            : topic === 'gotchas' ? 'Gotchas'
            : topic.startsWith('modules/') ? `Module: ${topic.split('/')[1]}`
            : topic.charAt(0).toUpperCase() + topic.slice(1);

          sections.push(`### ${heading}`);
          for (const r of topicResults) {
            const marker = topic === 'gotchas' ? '[!] ' : topic === 'preferences' ? '[pref] ' : '';
            const keywords = r.matchedKeywords.length > 0 ? ` (matched: ${r.matchedKeywords.join(', ')})` : '';
            const lobeLabel = showCtxLobeLabels ? ` [${ctxEntryLobeMap.get(r.entry.id) ?? '?'}]` : '';
            const tagsSuffix = r.entry.tags?.length ? ` [tags: ${r.entry.tags.join(', ')}]` : '';
            sections.push(`- **${marker}${r.entry.title}**${lobeLabel}: ${r.entry.content}${keywords}${tagsSuffix}`);
          }
          sections.push('');
        }

        // Conflict detection on the result set (cross-topic — exactly when the agent needs it)
        if (primaryStore) {
          const ctxConflicts = primaryStore.detectConflicts(results.map(r => r.entry));
          if (ctxConflicts.length > 0) {
            sections.push(formatConflictWarning(ctxConflicts));
          }
        }

        // Search mode indicator — lightweight getters, no extra disk reload
        if (primaryStore) {
          sections.push(formatSearchMode(
            primaryStore.hasEmbedder,
            primaryStore.vectorCount,
            primaryStore.entryCount,
          ));
        }

        // Collect all matched keywords and topics for the dedup hint
        const allMatchedKeywords = new Set<string>();
        const matchedTopics = new Set<string>();
        for (const r of results) {
          for (const kw of r.matchedKeywords) allMatchedKeywords.add(kw);
          matchedTopics.add(r.entry.topic);
        }
        
        if (allMatchedKeywords.size > 0) {
          const kwList = Array.from(allMatchedKeywords).sort().join(', ');
          const topicList = Array.from(matchedTopics).sort().join(', ');
          sections.push(
            `---\n*Context loaded for: ${kwList} (${topicList}). ` +
            `This knowledge is now in your conversation — no need to call memory_context again for these terms this session.*`
          );
        }

        // Surface hint when we fell back to global-only
        if (ctxGlobalOnlyHint) {
          sections.push(`> ${ctxGlobalOnlyHint}`);
        }

        // Build footer (context search has no filter — it's natural language keyword matching)
        const ctxFooter = buildQueryFooter({ filterGroups: ctxFilterGroups, rawFilter: undefined, tagFreq: ctxTagFreq, resultCount: results.length, scope: 'context search' });
        sections.push(`---\n${ctxFooter}`);

        return { content: [{ type: 'text', text: sections.join('\n') }] };
      }

      case 'memory_stats': {
        const { lobe: rawLobe } = z.object({
          lobe: z.string().optional(),
        }).parse(args ?? {});

        // Single lobe stats
        if (rawLobe) {
          const ctx = resolveToolContext(rawLobe);
          if (!ctx.ok) return contextError(ctx);
          const result = await ctx.store.stats();
          const alwaysIncludeSet = new Set(configManager.getAlwaysIncludeLobes());
          const label = alwaysIncludeSet.has(rawLobe) ? `${ctx.label} (alwaysInclude)` : ctx.label;
          return { content: [{ type: 'text', text: formatStats(label, result) }] };
        }

        // Combined stats across all lobes
        const sections: string[] = [];
        const allLobeNames = configManager.getLobeNames();
        const alwaysIncludeSet = new Set(configManager.getAlwaysIncludeLobes());
        for (const lobeName of allLobeNames) {
          const store = configManager.getStore(lobeName);
          if (!store) continue;
          const result = await store.stats();
          const label = alwaysIncludeSet.has(lobeName) ? `${lobeName} (alwaysInclude)` : lobeName;
          sections.push(formatStats(label, result));
        }

        return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] };
      }

      case 'memory_reembed': {
        const { lobe: rawLobe } = z.object({
          lobe: z.string().optional(),
        }).parse(args ?? {});

        const lobeName = rawLobe ?? lobeNames[0];
        const ctx = resolveToolContext(lobeName);
        if (!ctx.ok) return contextError(ctx);

        const result = await ctx.store.reEmbed();

        if (result.error) {
          return { content: [{ type: 'text', text: `[${ctx.label}] Re-embed failed: ${result.error}` }] };
        }

        const parts = [
          `[${ctx.label}] Re-embedded ${result.embedded} entries`,
          `(${result.skipped} skipped, ${result.failed} failed).`,
        ];

        // Hint if many entries were vectorized
        if (result.embedded > 0) {
          parts.push('\nSemantic search is now active for these entries.');
        }

        return { content: [{ type: 'text', text: parts.join(' ') }] };
      }

      case 'memory_bootstrap': {
        const { lobe: rawLobe, root, budgetMB } = z.object({
          lobe: z.string().optional(),
          root: z.string().optional(),
          budgetMB: z.number().positive().optional(),
        }).parse(args);

        // Auto-create lobe: if the lobe is unknown AND root is provided AND config is
        // file-based, write the new lobe entry into memory-config.json and hot-reload.
        // This lets the agent bootstrap a brand-new repo in a single tool call.
        if (rawLobe && root && !configManager.getStore(rawLobe)) {
          const origin = configManager.getConfigOrigin();
          if (origin.source !== 'file') {
            return {
              content: [{
                type: 'text',
                text: `Cannot auto-add lobe "${rawLobe}": config is not file-based (source: ${origin.source}).\n\n` +
                  `Create memory-config.json next to the memory MCP server with a "lobes" block, then retry.`,
              }],
              isError: true,
            };
          }

          try {
            const raw = await readFile(origin.path, 'utf-8');
            const config = JSON.parse(raw) as { lobes?: Record<string, unknown> };
            if (!config.lobes || typeof config.lobes !== 'object') config.lobes = {};
            config.lobes[rawLobe] = { root, budgetMB: budgetMB ?? 2 };
            await writeFile(origin.path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
            process.stderr.write(`[memory-mcp] Auto-added lobe "${rawLobe}" (root: ${root}) to memory-config.json\n`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text', text: `Failed to auto-add lobe "${rawLobe}" to memory-config.json: ${message}` }],
              isError: true,
            };
          }

          // Reload config to pick up the new lobe (hot-reload detects the updated mtime)
          await configManager.ensureFresh();
        }

        // Resolve store — after this point, rawLobe is never used again
        const ctx = resolveToolContext(rawLobe);
        if (!ctx.ok) return contextError(ctx);

        const results = await ctx.store.bootstrap();
        const stored = results.filter((r): r is Extract<typeof r, { kind: 'stored' }> => r.kind === 'stored');
        const failed = results.filter((r): r is Extract<typeof r, { kind: 'rejected' | 'review-required' }> => r.kind !== 'stored');

        let text = `## [${ctx.label}] Bootstrap Complete\n\nStored ${stored.length} entries:`;
        for (const r of stored) {
          text += `\n- ${r.id}: ${r.topic} (${r.file})`;
        }
        if (failed.length > 0) {
          text += `\n\n${failed.length} entries failed:`;
          for (const r of failed) {
            text += `\n- ${r.warning}`;
          }
        }

        return { content: [{ type: 'text', text }] };
      }

      case 'memory_diagnose': {
        // Delegates to shared builder — same data as memory://diagnostics resource
        const { showCrashHistory } = z.object({
          showCrashHistory: z.boolean().default(false),
        }).parse(args ?? {});

        const text = await buildDiagnosticsText(showCrashHistory);
        return { content: [{ type: 'text', text }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Provide helpful hints for common Zod validation errors
    let hint = '';
    if (message.includes('"lobe"') && message.includes('Required')) {
      const lobeNames = configManager.getLobeNames();
      hint = `\n\nHint: lobe is required. Use memory_list_lobes to see available lobes. Available: ${lobeNames.join(', ')}`;
    } else if (message.includes('"topic"') || message.includes('"entries"')) {
      hint = '\n\nHint: memory_store requires: topic (architecture|conventions|gotchas|recent-work|modules/<name>) and entries (Array<{title, fact}>). Example: entries: [{title: "Build cache", fact: "Must clean build after Tuist changes"}]. Use modules/<name> for custom namespaces.';
    } else if (message.includes('"scope"')) {
      hint = '\n\nHint: memory_query requires: lobe, scope (architecture|conventions|gotchas|recent-work|modules/<name>|* for all)';
    }

    return {
      content: [{ type: 'text', text: `Error: ${message}${hint}` }],
      isError: true,
    };
  }
});

// --- Helpers ---

/** Build lobe info array — shared by memory_list_lobes tool and memory://lobes resource */
async function buildLobeInfo() {
  const lobeNames = configManager.getLobeNames();
  return Promise.all(
    lobeNames.map(async (name) => {
      const config = configManager.getLobeConfig(name)!;
      const health = configManager.getLobeHealth(name) ?? { status: 'healthy' as const };
      const store = configManager.getStore(name);

      if (health.status === 'degraded' || !store) {
        return {
          name,
          root: config.repoRoot,
          memoryPath: config.memoryPath,
          health: 'degraded',
          error: health.status === 'degraded' ? health.error : 'Store not initialized',
          recovery: health.status === 'degraded' ? health.recovery : ['Toggle MCP to restart'],
        };
      }

      const stats = await store.stats();
      return {
        name,
        root: config.repoRoot,
        memoryPath: config.memoryPath,
        health: 'healthy',
        entries: stats.totalEntries,
        storageUsed: stats.storageSize,
        storageBudget: `${Math.round(config.storageBudgetBytes / 1024 / 1024)}MB`,
      };
    })
  );
}

/** Build diagnostics text — shared by memory_diagnose tool and memory://diagnostics resource */
async function buildDiagnosticsText(showFullCrashHistory: boolean): Promise<string> {
  const sections: string[] = [];

  const lobeNames = configManager.getLobeNames();
  const configOrigin = configManager.getConfigOrigin();

  sections.push(`## Memory MCP Server Diagnostics`);
  sections.push('');
  sections.push(`**Server mode:** ${serverMode.kind}`);
  sections.push(`**Uptime:** ${Math.round((Date.now() - serverStartTime) / 1000)}s`);
  sections.push(`**Config source:** ${configOrigin.source}`);
  sections.push(`**Lobes:** ${lobeNames.length} configured`);
  sections.push('');

  sections.push(`### Lobe Health`);
  for (const lobeName of lobeNames) {
    const health = configManager.getLobeHealth(lobeName) ?? { status: 'healthy' as const };
    if (health.status === 'healthy') {
      const store = configManager.getStore(lobeName);
      if (store) {
        const stats = await store.stats();
        sections.push(`- **${lobeName}**: ✅ healthy (${stats.totalEntries} entries, ${stats.storageSize}${stats.corruptFiles > 0 ? `, ${stats.corruptFiles} corrupt files` : ''})`);
      } else {
        sections.push(`- **${lobeName}**: ⚠ store not initialized`);
      }
    } else {
      sections.push(`- **${lobeName}**: ❌ degraded — ${health.error}`);
      for (const step of health.recovery) {
        sections.push(`  - ${step}`);
      }
    }
  }
  sections.push('');

  // Active behavior config — shows effective values and highlights user overrides
  sections.push('### Active Behavior Config');
  sections.push(formatBehaviorConfigSection(configBehavior));
  sections.push('');

  const latestCrash = await readLatestCrash();
  if (latestCrash) {
    sections.push('### Latest Crash');
    sections.push(formatCrashReport(latestCrash));
    sections.push('');
    await clearLatestCrash();
  } else {
    sections.push('### Crash History');
    sections.push('No recent crashes recorded. ✅');
    sections.push('');
  }

  if (showFullCrashHistory) {
    const history = await readCrashHistory(10);
    if (history.length > 0) {
      sections.push('### Full Crash History (last 10)');
      for (const crash of history) {
        sections.push(`- **${crash.timestamp}** [${crash.type}]: ${crash.error.substring(0, 100)}`);
        sections.push(`  Phase: ${crash.context.phase}, Uptime: ${crash.serverUptime}s`);
      }
      sections.push('');
    }
  }

  if (serverMode.kind === 'safe-mode') {
    sections.push('### Safe Mode Recovery');
    sections.push('The server is in safe mode — knowledge tools are disabled.');
    for (const step of serverMode.recovery) {
      sections.push(`- ${step}`);
    }
  } else if (serverMode.kind === 'degraded') {
    sections.push('### Degraded Mode');
    sections.push(`Some lobes have issues: ${serverMode.reason}`);
    sections.push('Healthy lobes continue to work normally.');
  }

  return sections.join('\n');
}

// --- Startup ---
async function main() {
  markServerStarted();

  // Check for crash report from a previous run
  const previousCrash = await readLatestCrash();
  if (previousCrash) {
    const age = Math.round((Date.now() - new Date(previousCrash.timestamp).getTime()) / 1000);
    process.stderr.write(`[memory-mcp] Previous crash detected (${age}s ago): ${previousCrash.type} — ${previousCrash.error}\n`);
    process.stderr.write(`[memory-mcp] Crash report will be shown in memory_context and memory_diagnose.\n`);
  }

  // Initialize each lobe independently — a broken lobe shouldn't prevent others from working
  let healthyLobes = 0;
  for (const [name, config] of lobeConfigs) {
    try {
      const store = new MarkdownMemoryStore(config);
      await store.init();
      stores.set(name, store);
      lobeHealth.set(name, { status: 'healthy' });
      healthyLobes++;
      process.stderr.write(`[memory-mcp] ✅ Lobe "${name}" → ${config.repoRoot} (memory: ${config.memoryPath})\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[memory-mcp] ❌ Lobe "${name}" failed to init: ${msg}\n`);

      lobeHealth.set(name, {
        status: 'degraded',
        error: msg,
        since: new Date().toISOString(),
        recovery: [
          `Verify the repo root exists: ${config.repoRoot}`,
          'Check file permissions on the memory directory.',
          'If the repo was moved, update memory-config.json.',
          'Toggle the MCP off/on to retry initialization.',
        ],
      });

      const report = buildCrashReport(error, 'lobe-init-failure', {
        phase: 'startup',
        activeLobe: name,
        configSource: configOrigin.source,
        lobeCount: lobeConfigs.size,
      });
      await writeCrashReport(report).catch(() => {});
    }
  }

  // Determine server mode based on lobe health
  if (healthyLobes === 0) {
    serverMode = {
      kind: 'safe-mode',
      error: `All ${lobeConfigs.size} lobes failed to initialize.`,
      recovery: [
        'Check that repo paths in memory-config.json exist and are accessible.',
        'Verify git is installed and functional.',
        'Check file permissions on ~/.memory-mcp/.',
        'Toggle the MCP off/on to retry.',
        'Call memory_diagnose for detailed error information.',
      ],
    };
    process.stderr.write(`[memory-mcp] ⚠ SAFE MODE: all lobes failed. Server alive but degraded.\n`);
  } else if (healthyLobes < lobeConfigs.size) {
    const degradedNames = lobeNames.filter(n => lobeHealth.get(n)?.status === 'degraded');
    serverMode = {
      kind: 'degraded',
      reason: `${degradedNames.length} lobe(s) degraded: ${degradedNames.join(', ')}`,
    };
    process.stderr.write(`[memory-mcp] ⚠ DEGRADED: ${healthyLobes}/${lobeConfigs.size} lobes healthy.\n`);
  }

  // Initialize ConfigManager with current config state
  configManager = new ConfigManager(configPath, { configs: lobeConfigs, origin: configOrigin }, stores, lobeHealth);

  const transport = new StdioServerTransport();

  // Handle transport errors — journal and exit
  transport.onerror = (error) => {
    process.stderr.write(`[memory-mcp] Transport error: ${error}\n`);
    const report = buildCrashReport(error, 'transport-error', currentCrashContext('running'));
    writeCrashReportSync(report);
  };

  server.onerror = (error) => {
    process.stderr.write(`[memory-mcp] Server error: ${error}\n`);
  };

  // Handle stdin/stdout pipe breaks
  process.stdin.on('end', () => {
    process.stderr.write('[memory-mcp] stdin closed — host disconnected. Exiting.\n');
    process.exit(0);
  });
  process.stdin.on('close', () => {
    process.stderr.write('[memory-mcp] stdin closed. Exiting.\n');
    process.exit(0);
  });
  process.stdout.on('error', (error) => {
    process.stderr.write(`[memory-mcp] stdout error (pipe broken?): ${error.message}\n`);
    process.exit(0);
  });

  await server.connect(transport);
  const modeStr = serverMode.kind === 'running' ? '' : ` [${serverMode.kind.toUpperCase()}]`;
  const alwaysIncludeNames = configManager.getAlwaysIncludeLobes();
  const aiLabel = alwaysIncludeNames.length > 0 ? ` (alwaysInclude: ${alwaysIncludeNames.join(', ')})` : '';
  if (alwaysIncludeNames.length > 1) {
    process.stderr.write(`[memory-mcp] Warning: ${alwaysIncludeNames.length} lobes have alwaysInclude: true (${alwaysIncludeNames.join(', ')}). Writes to user/preferences will route to the first one ("${alwaysIncludeNames[0]}"). This is likely a misconfiguration — typically only one lobe should be alwaysInclude.\n`);
  }
  process.stderr.write(`[memory-mcp] Server started${modeStr} with ${healthyLobes}/${lobeConfigs.size} lobe(s)${aiLabel}\n`);

  // Graceful shutdown on signals
  const shutdown = () => {
    process.stderr.write('[memory-mcp] Shutting down gracefully.\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`[memory-mcp] Fatal startup error: ${error}\n`);
  if (error instanceof Error && error.stack) {
    process.stderr.write(`[memory-mcp] Stack: ${error.stack}\n`);
  }

  const report = buildCrashReport(error, 'startup-failure', {
    phase: 'startup',
    configSource: configOrigin.source,
    lobeCount: lobeConfigs.size,
  });
  writeCrashReportSync(report);

  process.exit(1);
});
