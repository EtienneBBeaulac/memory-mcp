#!/usr/bin/env node

// Codebase Memory MCP Server
// Provides persistent, evolving knowledge for AI coding agents
// Supports multiple workspaces simultaneously

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import path from 'path';
import os from 'os';
import { existsSync, writeFileSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { MarkdownMemoryStore } from './store.js';
import type { DetailLevel, TopicScope, TrustLevel } from './types.js';
import { DEFAULT_STORAGE_BUDGET_BYTES, parseTopicScope, parseTrustLevel, parseTags } from './types.js';
import { getLobeConfigs, type ConfigOrigin } from './config.js';
import { ConfigManager } from './config-manager.js';
import { normalizeArgs } from './normalize.js';
import {
  buildCrashReport, writeCrashReport, writeCrashReportSync, readLatestCrash,
  readCrashHistory, clearLatestCrash, formatCrashReport, formatCrashSummary,
  markServerStarted, type CrashContext, type CrashReport,
} from './crash-journal.js';
import { formatStaleSection, formatConflictWarning, formatStats, formatBehaviorConfigSection, mergeTagFrequencies, buildQueryFooter, buildTagPrimerSection } from './formatters.js';
import { extractKeywords, parseFilter, type FilterGroup } from './text-analyzer.js';
import { CROSS_LOBE_WEAK_SCORE_PENALTY, CROSS_LOBE_MIN_MATCH_RATIO, VOCABULARY_ECHO_LIMIT, MAX_FOOTER_TAGS } from './thresholds.js';

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

// Global store for user identity + preferences (shared across all lobes)
const GLOBAL_TOPICS = new Set<string>(['user', 'preferences']);
const globalMemoryPath = path.join(os.homedir(), '.memory-mcp', 'global');
const globalStore = new MarkdownMemoryStore({
  repoRoot: os.homedir(),
  memoryPath: globalMemoryPath,
  storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES,
});

/** Resolved tool context — after resolution, the raw lobe string is inaccessible.
 *  This eliminates the entire class of bugs where handlers accidentally use
 *  the unresolved lobe input instead of the resolved one. */
type ToolContext =
  | { readonly ok: true; readonly store: MarkdownMemoryStore; readonly label: string }
  | { readonly ok: false; readonly error: string };

/** Resolve a raw lobe name to a validated store + display label.
 *  After this call, consumers use ctx.label — the raw lobe is not in scope. */
function resolveToolContext(rawLobe: string | undefined, opts?: { isGlobal?: boolean }): ToolContext {
  // Global topics always route to the global store
  if (opts?.isGlobal) {
    return { ok: true, store: globalStore, label: 'global' };
  }

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
  { capabilities: { tools: {} } }
);

/** Build the shared lobe property for tool schemas — called on each ListTools request
 *  so the description and enum stay in sync after a hot-reload adds or removes lobes. */
function buildLobeProperty(currentLobeNames: readonly string[]) {
  const isSingle = currentLobeNames.length === 1;
  return {
    type: 'string' as const,
    description: isSingle
      ? `Memory lobe name (defaults to "${currentLobeNames[0]}" if omitted)`
      : `Memory lobe name. Optional for reads (query/context/briefing/stats search all lobes when omitted). Required for writes (store/correct/bootstrap). Available: ${currentLobeNames.join(', ')}`,
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
    // memory_list_lobes is hidden — lobe info is surfaced in memory_context() hints
    // and memory_stats. The handler still works if called directly.
    {
      name: 'memory_store',
      description: 'Store knowledge. "user" and "preferences" are global (no lobe needed). Use tags for exact-match categorization. Add a shared tag (e.g., "test-entry") for bulk operations. Example: memory_store(topic: "gotchas", title: "Build cache", content: "Must clean build after Tuist changes", tags: ["build", "ios"])',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          topic: {
            type: 'string',
            // modules/<name> is intentionally excluded from the enum so the MCP schema
            // doesn't restrict it — agents can pass any "modules/foo" value and it works.
            // The description makes this explicit.
            description: 'Predefined: user | preferences | architecture | conventions | gotchas | recent-work. Custom namespace: modules/<name> (e.g. modules/brainstorm, modules/game-design, modules/api-notes). Use modules/<name> for any domain that doesn\'t fit the built-in topics.',
            enum: ['user', 'preferences', 'architecture', 'conventions', 'gotchas', 'recent-work'],
          },
          title: {
            type: 'string',
            description: 'Short title for this entry',
          },
          content: {
            type: 'string',
            description: 'The knowledge to store',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'File paths that informed this (provenance, for freshness tracking)',
            default: [],
          },
          references: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files, classes, or symbols this knowledge is about (semantic pointers). Example: ["features/messaging/impl/MessagingReducer.kt"]',
            default: [],
          },
          trust: {
            type: 'string',
            enum: ['user', 'agent-confirmed', 'agent-inferred'],
            description: 'user (from human) > agent-confirmed > agent-inferred',
            default: 'agent-inferred',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Category labels for exact-match retrieval (lowercase slugs). Query with filter: "#tag". Example: ["auth", "critical-path", "mite-combat"]',
            default: [],
          },
        },
        required: ['topic', 'title', 'content'],
      },
    },
    {
      name: 'memory_query',
      description: 'Search stored knowledge. Searches all lobes when lobe is omitted. Filter supports: keywords (stemmed), #tag (exact tag match), =term (exact keyword, no stemming), -term (NOT). Example: memory_query(scope: "*", filter: "#auth reducer", detail: "full")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          scope: {
            type: 'string',
            description: 'Optional. Defaults to "*" (all topics). Options: * | user | preferences | architecture | conventions | gotchas | recent-work | modules/<name>',
          },
          detail: {
            type: 'string',
            enum: ['brief', 'standard', 'full'],
            description: 'brief = titles only, standard = summaries, full = complete content + metadata',
            default: 'brief',
          },
          filter: {
            type: 'string',
            description: 'Search terms. "A B" = AND, "A|B" = OR, "-A" = NOT, "#tag" = exact tag, "=term" = exact keyword (no stemming). Example: "#auth reducer -deprecated"',
          },
          branch: {
            type: 'string',
            description: 'Branch for recent-work. Omit = current branch, "*" = all branches.',
          },
        },
        required: [],
      },
    },

    {
      name: 'memory_correct',
      description: 'Fix or delete an entry. Example: memory_correct(id: "arch-3f7a", action: "replace", correction: "updated content")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          id: {
            type: 'string',
            description: 'Entry ID (e.g. arch-3f7a, pref-5c9b)',
          },
          correction: {
            type: 'string',
            description: 'New text (for append/replace). Not needed for delete.',
          },
          action: {
            type: 'string',
            enum: ['append', 'replace', 'delete'],
            description: 'append | replace | delete',
          },
        },
        required: ['id', 'action'],
      },
    },
    {
      name: 'memory_context',
      description: 'Session start AND pre-task lookup. Call with no args at session start to get user identity, preferences, and stale entries. Call with context to get task-specific knowledge. Searches all lobes when lobe is omitted. Example: memory_context() or memory_context(context: "writing a Kotlin reducer")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: lobeProperty,
          context: {
            type: 'string',
            description: 'Optional. What you are about to do, in natural language. Omit for session-start briefing (user + preferences + stale entries).',
          },
          maxResults: {
            type: 'number',
            description: 'Max results (default: 10)',
            default: 10,
          },
          minMatch: {
            type: 'number',
            description: 'Min keyword match ratio 0-1 (default: 0.2). Higher = stricter.',
            default: 0.2,
          },
        },
        required: [],
      },
    },
    // memory_stats is hidden — agents rarely need it proactively. Mentioned in
    // hints when storage is running low. The handler still works if called directly.
    {
      name: 'memory_bootstrap',
      description: 'First-time setup: scan repo structure, README, and build system to seed initial knowledge. Run once per new codebase. If the lobe does not exist yet, provide "root" to auto-add it to memory-config.json and proceed without a manual restart.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lobe: {
            type: 'string' as const,
            // No enum restriction: agents pass new lobe names not yet in the config
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
    // memory_diagnose is intentionally hidden from the tool list — it clutters
    // agent tool discovery and should only be called when directed by error messages
    // or crash reports. The handler still works if called directly.
  ] };
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
        const globalStats = await globalStore.stats();
        const result = {
          serverMode: serverMode.kind,
          globalStore: {
            memoryPath: globalMemoryPath,
            entries: globalStats.totalEntries,
            storageUsed: globalStats.storageSize,
            topics: 'user, preferences (shared across all lobes)',
          },
          lobes: lobeInfo,
          configFile: configFileDisplay(),
          configSource: configOrigin.source,
          totalLobes: lobeInfo.length,
          degradedLobes: lobeInfo.filter((l: { health: string }) => l.health === 'degraded').length,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'memory_store': {
        const { lobe: rawLobe, topic: rawTopic, title, content, sources, references, trust: rawTrust, tags: rawTags } = z.object({
          lobe: z.string().optional(),
          topic: z.string(),
          title: z.string().min(1),
          content: z.string().min(1),
          sources: z.array(z.string()).default([]),
          references: z.array(z.string()).default([]),
          trust: z.enum(['user', 'agent-confirmed', 'agent-inferred']).default('agent-inferred'),
          tags: z.array(z.string()).default([]),
        }).parse(args);

        // Validate topic at boundary
        const topic = parseTopicScope(rawTopic);
        if (!topic) {
          return {
            content: [{ type: 'text', text: `Invalid topic: "${rawTopic}". Valid: user | preferences | architecture | conventions | gotchas | recent-work | modules/<name>` }],
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

        // Resolve store — after this point, rawLobe is never used again
        const isGlobal = GLOBAL_TOPICS.has(topic);
        const ctx = resolveToolContext(effectiveLobe, { isGlobal });
        if (!ctx.ok) return contextError(ctx);

        const result = await ctx.store.store(
          topic,
          title,
          content,
          sources,
          // User/preferences default to 'user' trust unless explicitly set otherwise
          isGlobal && trust === 'agent-inferred' ? 'user' : trust,
          references,
          rawTags,
        );

        if (!result.stored) {
          return {
            content: [{ type: 'text', text: `[${ctx.label}] Failed to store: ${result.warning}` }],
            isError: true,
          };
        }

        const lines: string[] = [
          `[${ctx.label}] Stored entry ${result.id} in ${result.topic} (confidence: ${result.confidence})`,
        ];
        if (result.warning) lines.push(`Note: ${result.warning}`);

        // Limit to at most 2 hint sections per response to prevent hint fatigue.
        // Priority: dedup > ephemeral > preferences (dedup is actionable and high-signal,
        // ephemeral warnings affect entry quality, preferences are informational).
        let hintCount = 0;

        // Dedup: surface related entries in the same topic
        if (result.relatedEntries && result.relatedEntries.length > 0 && hintCount < 2) {
          hintCount++;
          lines.push('');
          lines.push('⚠ Similar entries found in the same topic:');
          for (const r of result.relatedEntries) {
            lines.push(`  - ${r.id}: "${r.title}" (confidence: ${r.confidence})`);
            lines.push(`    Content: ${r.content.length > 120 ? r.content.substring(0, 120) + '...' : r.content}`);
          }
          lines.push('');
          lines.push('To consolidate: memory_correct(id: "<old-id>", action: "replace", correction: "<merged content>") then memory_correct(id: "<new-id>", action: "delete")');
        }

        // Ephemeral content warning — soft nudge, never blocking
        if (result.ephemeralWarning && hintCount < 2) {
          hintCount++;
          lines.push('');
          lines.push(`⏳ ${result.ephemeralWarning}`);
        }

        // Preference surfacing: show relevant preferences for non-preference entries
        if (result.relevantPreferences && result.relevantPreferences.length > 0 && hintCount < 2) {
          hintCount++;
          lines.push('');
          lines.push('📌 Relevant preferences:');
          for (const p of result.relevantPreferences) {
            lines.push(`  - [pref] ${p.title}: ${p.content.length > 120 ? p.content.substring(0, 120) + '...' : p.content}`);
          }
          lines.push('');
          lines.push('Review the stored entry against these preferences for potential conflicts.');
        }

        // Vocabulary echo: show existing tags to drive convergence
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
        const { lobe: rawLobe, scope, detail, filter, branch } = z.object({
          lobe: z.string().optional(),
          scope: z.string().default('*'),
          detail: z.enum(['brief', 'standard', 'full']).default('brief'),
          filter: z.string().optional(),
          branch: z.string().optional(),
        }).parse(args ?? {});

        const isGlobalQuery = GLOBAL_TOPICS.has(scope);

        // For global topics (user, preferences), always route to global store.
        // For lobe topics: if lobe specified → single lobe. If omitted → ALL healthy lobes.
        let lobeEntries: import('./types.js').QueryEntry[] = [];
        const entryLobeMap = new Map<string, string>(); // entry id → lobe name (for cross-lobe labeling)
        let label: string;
        let primaryStore: MarkdownMemoryStore | undefined;
        let isMultiLobe = false;

        if (isGlobalQuery) {
          const ctx = resolveToolContext(rawLobe, { isGlobal: true });
          if (!ctx.ok) return contextError(ctx);
          label = ctx.label;
          primaryStore = ctx.store;
          const result = await ctx.store.query(scope, detail as DetailLevel, filter, branch);
          for (const e of result.entries) entryLobeMap.set(e.id, 'global');
          lobeEntries = [...result.entries];
        } else if (rawLobe) {
          const ctx = resolveToolContext(rawLobe);
          if (!ctx.ok) return contextError(ctx);
          label = ctx.label;
          primaryStore = ctx.store;
          const result = await ctx.store.query(scope, detail as DetailLevel, filter, branch);
          lobeEntries = [...result.entries];
        } else {
          // Search all healthy lobes — read operations shouldn't require lobe selection
          const allLobeNames = configManager.getLobeNames();
          isMultiLobe = allLobeNames.length > 1;
          label = allLobeNames.length === 1 ? allLobeNames[0] : 'all';
          for (const lobeName of allLobeNames) {
            const store = configManager.getStore(lobeName);
            if (!store) continue;
            if (!primaryStore) primaryStore = store;
            const result = await store.query(scope, detail as DetailLevel, filter, branch);
            for (const e of result.entries) entryLobeMap.set(e.id, lobeName);
            lobeEntries.push(...result.entries);
          }
        }

        // For wildcard queries on non-global topics, also include global store entries
        let globalEntries: typeof lobeEntries = [];
        if (scope === '*' && !isGlobalQuery) {
          const globalResult = await globalStore.query('*', detail as DetailLevel, filter);
          for (const e of globalResult.entries) entryLobeMap.set(e.id, 'global');
          globalEntries = [...globalResult.entries];
        }

        // Merge global + lobe entries, dedupe by id, sort by relevance score
        const seenQueryIds = new Set<string>();
        const allEntries = [...globalEntries, ...lobeEntries]
          .filter(e => {
            if (seenQueryIds.has(e.id)) return false;
            seenQueryIds.add(e.id);
            return true;
          })
          .sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Build stores collection for tag frequency aggregation
        const searchedStores: MarkdownMemoryStore[] = [];
        if (isGlobalQuery) {
          searchedStores.push(globalStore);
        } else if (rawLobe) {
          const store = configManager.getStore(rawLobe);
          if (store) searchedStores.push(store);
        } else {
          // All lobes + global when doing wildcard search
          for (const lobeName of configManager.getLobeNames()) {
            const store = configManager.getStore(lobeName);
            if (store) searchedStores.push(store);
          }
          if (scope === '*') searchedStores.push(globalStore);
        }
        const tagFreq = mergeTagFrequencies(searchedStores);

        // Parse filter once for both filtering (already done) and footer display
        const filterGroups = filter ? parseFilter(filter) : [];

        if (allEntries.length === 0) {
          const footer = buildQueryFooter({ filterGroups, rawFilter: filter, tagFreq, resultCount: 0, scope });
          return {
            content: [{
              type: 'text',
              text: `[${label}] No entries found for scope "${scope}"${filter ? ` with filter "${filter}"` : ''}.\n\n---\n${footer}`,
            }],
          };
        }

        const lines = allEntries.map(e => {
          const freshIndicator = e.fresh ? '' : ' [stale]';
          const lobeTag = isMultiLobe ? ` [${entryLobeMap.get(e.id) ?? '?'}]` : '';
          if (detail === 'brief') {
            return `- **${e.title}** (${e.id}${lobeTag}, confidence: ${e.confidence})${freshIndicator}\n  ${e.summary}`;
          }
          if (detail === 'full') {
            const meta = [
              `ID: ${e.id}`,
              isMultiLobe ? `Lobe: ${entryLobeMap.get(e.id) ?? '?'}` : null,
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

        // Resolve store — route global entries (user-*, pref-*) to global store
        const isGlobalEntry = id.startsWith('user-') || id.startsWith('pref-');
        const ctx = resolveToolContext(rawLobe, { isGlobal: isGlobalEntry });
        if (!ctx.ok) return contextError(ctx);

        const result = await ctx.store.correct(id, correction ?? '', action);

        if (!result.corrected) {
          // If not found in the targeted store, try the other one as fallback
          if (isGlobalEntry) {
            const lobeCtx = resolveToolContext(rawLobe);
            if (lobeCtx.ok) {
              const lobeResult = await lobeCtx.store.correct(id, correction ?? '', action);
              if (lobeResult.corrected) {
                const text = action === 'delete'
                  ? `[${lobeCtx.label}] Deleted entry ${id}.`
                  : `[${lobeCtx.label}] Corrected entry ${id} (action: ${action}, confidence: ${lobeResult.newConfidence}, trust: ${lobeResult.trust}).`;
                return { content: [{ type: 'text', text }] };
              }
            }
          }
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
        const { lobe: rawLobe, context, maxResults, minMatch } = z.object({
          lobe: z.string().optional(),
          context: z.string().optional(),
          maxResults: z.number().optional(),
          minMatch: z.number().min(0).max(1).optional(),
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

          // Global store holds user + preferences — always included
          const globalBriefing = await globalStore.briefing(300);

          const sections: string[] = [];
          if (crashSection) sections.push(crashSection);
          if (degradedSection) sections.push(degradedSection);

          if (globalBriefing.entryCount > 0) {
            sections.push(globalBriefing.briefing);
          }

          // Collect stale entries and entry counts across all lobes
          const allStale: import('./types.js').StaleEntry[] = [];
          if (globalBriefing.staleDetails) allStale.push(...globalBriefing.staleDetails);
          let totalEntries = globalBriefing.entryCount;
          let totalStale = globalBriefing.staleEntries;

          for (const lobeName of allBriefingLobeNames) {
            const health = configManager.getLobeHealth(lobeName);
            if (health?.status === 'degraded') continue;
            const store = configManager.getStore(lobeName);
            if (!store) continue;
            const lobeBriefing = await store.briefing(100); // just enough for stale data + counts
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

          // Tag primer: show tag vocabulary if tags exist across any lobe
          const briefingStores: MarkdownMemoryStore[] = [globalStore];
          for (const lobeName of allBriefingLobeNames) {
            const store = configManager.getStore(lobeName);
            if (store) briefingStores.push(store);
          }
          const briefingTagFreq = mergeTagFrequencies(briefingStores);
          const tagPrimer = buildTagPrimerSection(briefingTagFreq);
          if (tagPrimer) {
            sections.push(tagPrimer);
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

        // Determine which lobes to search.
        // If lobe specified → single lobe. If omitted → ALL healthy lobes (cross-repo search).
        type ContextResult = { entry: import('./types.js').MemoryEntry; score: number; matchedKeywords: string[] };
        const allLobeResults: ContextResult[] = [];
        const ctxEntryLobeMap = new Map<string, string>(); // entry id → lobe name
        let label: string;
        let primaryStore: MarkdownMemoryStore | undefined;
        let isCtxMultiLobe = false;

        if (rawLobe) {
          const ctx = resolveToolContext(rawLobe);
          if (!ctx.ok) return contextError(ctx);
          label = ctx.label;
          primaryStore = ctx.store;
          const lobeResults = await ctx.store.contextSearch(context, max, undefined, threshold);
          allLobeResults.push(...lobeResults);
        } else {
          // Search all healthy lobes — read operations shouldn't require lobe selection
          const allLobeNames = configManager.getLobeNames();
          isCtxMultiLobe = allLobeNames.length > 1;
          label = allLobeNames.length === 1 ? allLobeNames[0] : 'all';
          for (const lobeName of allLobeNames) {
            const store = configManager.getStore(lobeName);
            if (!store) continue;
            if (!primaryStore) primaryStore = store;
            const lobeResults = await store.contextSearch(context, max, undefined, threshold);
            for (const r of lobeResults) ctxEntryLobeMap.set(r.entry.id, lobeName);
            allLobeResults.push(...lobeResults);
          }
        }

        // Cross-lobe weak-match penalty: demote results from other repos that only matched
        // on generic software terms (e.g. "codebase", "structure"). Without this, a high-
        // confidence entry from an unrelated repo can outrank genuinely relevant knowledge
        // simply because popular terms appear in it.
        // Applied only in multi-lobe mode; single-lobe and global results are never penalized.
        if (isCtxMultiLobe) {
          const contextKwCount = extractKeywords(context).size;
          // Minimum keyword matches required to avoid the penalty (at least 40% of context, min 2)
          const minMatchCount = Math.max(2, Math.ceil(contextKwCount * CROSS_LOBE_MIN_MATCH_RATIO));
          for (let i = 0; i < allLobeResults.length; i++) {
            if (allLobeResults[i].matchedKeywords.length < minMatchCount) {
              allLobeResults[i] = { ...allLobeResults[i], score: allLobeResults[i].score * CROSS_LOBE_WEAK_SCORE_PENALTY };
            }
          }
        }

        // Always include global store (user + preferences)
        const globalResults = await globalStore.contextSearch(context, max, undefined, threshold);
        for (const r of globalResults) ctxEntryLobeMap.set(r.entry.id, 'global');

        // Merge, dedupe by entry id, re-sort by score, take top N
        const seenIds = new Set<string>();
        const results = [...globalResults, ...allLobeResults]
          .sort((a, b) => b.score - a.score)
          .filter(r => {
            if (seenIds.has(r.entry.id)) return false;
            seenIds.add(r.entry.id);
            return true;
          })
          .slice(0, max);

        // Build stores collection for tag frequency aggregation
        const ctxSearchedStores: MarkdownMemoryStore[] = [globalStore];
        if (rawLobe) {
          const store = configManager.getStore(rawLobe);
          if (store) ctxSearchedStores.push(store);
        } else {
          for (const lobeName of configManager.getLobeNames()) {
            const store = configManager.getStore(lobeName);
            if (store) ctxSearchedStores.push(store);
          }
        }
        const ctxTagFreq = mergeTagFrequencies(ctxSearchedStores);

        // Parse filter for footer (context search has no filter, pass empty)
        const ctxFilterGroups: FilterGroup[] = [];

        if (results.length === 0) {
          const ctxFooter = buildQueryFooter({ filterGroups: ctxFilterGroups, rawFilter: undefined, tagFreq: ctxTagFreq, resultCount: 0, scope: 'context search' });
          return {
            content: [{
              type: 'text',
              text: `[${label}] No relevant knowledge found for: "${context}"\n\nThis is fine — proceed without prior context. As you learn things worth remembering, store them with memory_store.\n\n---\n${ctxFooter}`,
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
            const lobeLabel = isCtxMultiLobe ? ` [${ctxEntryLobeMap.get(r.entry.id) ?? '?'}]` : '';
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

        // Build footer (context search has no filter — it's natural language keyword matching)
        const ctxFooter = buildQueryFooter({ filterGroups: ctxFilterGroups, rawFilter: undefined, tagFreq: ctxTagFreq, resultCount: results.length, scope: 'context search' });
        sections.push(`---\n${ctxFooter}`);

        return { content: [{ type: 'text', text: sections.join('\n') }] };
      }

      case 'memory_stats': {
        const { lobe: rawLobe } = z.object({
          lobe: z.string().optional(),
        }).parse(args ?? {});

        // Always include global stats
        const globalStats = await globalStore.stats();

        // Single lobe stats
        if (rawLobe) {
          const ctx = resolveToolContext(rawLobe);
          if (!ctx.ok) return contextError(ctx);
          const result = await ctx.store.stats();
          const sections = [formatStats('global (user + preferences)', globalStats), formatStats(ctx.label, result)];
          return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] };
        }

        // Combined stats across all lobes
        const sections: string[] = [formatStats('global (user + preferences)', globalStats)];
        const allLobeNames = configManager.getLobeNames();
        for (const lobeName of allLobeNames) {
          const store = configManager.getStore(lobeName)!;
          const result = await store.stats();
          sections.push(formatStats(lobeName, result));
        }

        return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] };
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
        const stored = results.filter(r => r.stored);
        const failed = results.filter(r => !r.stored);

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
    } else if (message.includes('"topic"') || message.includes('"title"') || message.includes('"content"')) {
      hint = '\n\nHint: memory_store requires: topic (architecture|conventions|gotchas|recent-work|modules/<name>), title, content. Use modules/<name> for custom namespaces (e.g. modules/brainstorm, modules/game-design).';
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

  try {
    const globalStats = await globalStore.stats();
    sections.push(`- **global store**: ✅ healthy (${globalStats.totalEntries} entries, ${globalStats.storageSize})`);
  } catch (e) {
    sections.push(`- **global store**: ❌ error — ${e instanceof Error ? e.message : e}`);
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

  // Initialize global store (user + preferences, shared across all lobes)
  try {
    await globalStore.init();
    process.stderr.write(`[memory-mcp] Global store → ${globalMemoryPath}\n`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[memory-mcp] WARNING: Global store init failed: ${msg}\n`);
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

  // Migrate: move user + preferences entries from lobe stores to global store.
  // State-driven guard: skip if already completed (marker file present).
  const migrationMarker = path.join(globalMemoryPath, '.migrated');
  if (!existsSync(migrationMarker)) {
    let migrated = 0;
    for (const [name, store] of stores) {
      for (const topic of ['user', 'preferences'] as const) {
        try {
          const result = await store.query(topic, 'full');
          for (const entry of result.entries) {
            try {
              const globalResult = await globalStore.query(topic, 'full');
              const alreadyExists = globalResult.entries.some(g => g.title === entry.title);

              if (!alreadyExists && entry.content) {
                const trust = parseTrustLevel(entry.trust ?? 'user') ?? 'user';
                await globalStore.store(
                  topic,
                  entry.title,
                  entry.content,
                  [...(entry.sources ?? [])],
                  trust,
                );
                process.stderr.write(`[memory-mcp] Migrated ${entry.id} ("${entry.title}") from [${name}] → global\n`);
                migrated++;
              }

              await store.correct(entry.id, '', 'delete');
              process.stderr.write(`[memory-mcp] Removed ${entry.id} from [${name}] (now in global)\n`);
            } catch (entryError) {
              process.stderr.write(`[memory-mcp] Migration error for ${entry.id} in [${name}]: ${entryError}\n`);
            }
          }
        } catch (topicError) {
          process.stderr.write(`[memory-mcp] Migration error querying ${topic} in [${name}]: ${topicError}\n`);
        }
      }
    }
    // Write marker atomically — future startups skip this block entirely
    try {
      writeFileSync(migrationMarker, new Date().toISOString(), 'utf-8');
      if (migrated > 0) process.stderr.write(`[memory-mcp] Migration complete: ${migrated} entries moved to global store.\n`);
    } catch { /* marker write is best-effort */ }
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
  process.stderr.write(`[memory-mcp] Server started${modeStr} with ${healthyLobes}/${lobeConfigs.size} lobe(s) + global store\n`);

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
