// Argument normalization for MCP tool calls.
//
// Agents frequently guess wrong param names. This module resolves common aliases
// and applies defaults to avoid wasted round-trips from validation errors.
// Pure functions — no side effects, no state.

/** Global param aliases — apply to all tools regardless of name */
const GLOBAL_ALIASES: Record<string, string> = {
  // memory_store aliases
  refs: 'references',
  // tag aliases
  tag: 'tags',
  labels: 'tags',
  categories: 'tags',
  // lobe aliases
  workspace: 'lobe',
  repo: 'lobe',
};

/** Tool-specific param aliases — only apply when the tool name matches.
 *  Prevents `query` → `filter` rewriting from breaking `recall(query: "...")`. */
const TOOL_ALIASES: Record<string, Record<string, string>> = {
  // Legacy tools: "query" means "filter"
  memory_query: { query: 'filter', search: 'filter', keyword: 'filter' },
  memory_store: { scope: 'topic' },
  // Legacy tools: "description"/"task" mean "context"
  memory_context: { description: 'context', task: 'context' },
  // v2 retrieval tools: "query"/"search"/"description"/"task" mean "context"
  recall: { query: 'context', search: 'context', description: 'context', task: 'context' },
  // v2 storage tools: "content"/"note"/"fact" mean "observation"
  gotcha: { content: 'observation', note: 'observation', fact: 'observation', message: 'observation' },
  convention: { content: 'observation', note: 'observation', fact: 'observation', message: 'observation' },
  learn: { content: 'observation', note: 'observation', fact: 'observation', message: 'observation' },
  // v2 prefer: "preference"/"pref" mean "rule"
  prefer: { preference: 'rule', pref: 'rule' },
  // v2 fix: "text"/"content"/"replacement" mean "correction"
  fix: { text: 'correction', content: 'correction', replacement: 'correction' },
  // v2 retrieval: "filter"/"keyword" mean "area"
  gotchas: { filter: 'area', keyword: 'area', query: 'area', search: 'area' },
  conventions: { filter: 'area', keyword: 'area', query: 'area', search: 'area' },
};

/** Wildcard scope aliases — agents guess many variations instead of "*" */
const SCOPE_WILDCARDS = new Set([
  'all', 'everything', 'any', '*', 'global', 'project', 'repo',
  'workspace', 'every', 'full', 'complete',
]);

/** Normalize args before Zod validation: resolve aliases, default workspace, fix wildcards */
export function normalizeArgs(
  toolName: string,
  raw: Record<string, unknown> | undefined,
  lobeNames: readonly string[],
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(raw ?? {}) };

  // 1. Resolve global param aliases
  for (const [alias, canonical] of Object.entries(GLOBAL_ALIASES)) {
    if (alias in args && !(canonical in args)) {
      args[canonical] = args[alias];
      delete args[alias];
    }
  }

  // 2. Resolve tool-specific param aliases
  const toolSpecific = TOOL_ALIASES[toolName];
  if (toolSpecific) {
    for (const [alias, canonical] of Object.entries(toolSpecific)) {
      if (alias in args && !(canonical in args)) {
        args[canonical] = args[alias];
        delete args[alias];
      }
    }
  }

  // 3. Default lobe to the only available one when omitted
  if (!('lobe' in args) || args['lobe'] === undefined || args['lobe'] === '') {
    if (lobeNames.length === 1) {
      args['lobe'] = lobeNames[0];
    }
  }

  // 4. Normalize wildcard scope values
  if ('scope' in args && typeof args['scope'] === 'string') {
    if (SCOPE_WILDCARDS.has(args['scope'].toLowerCase())) {
      args['scope'] = '*';
    }
  }

  // 5. For memory_query: default scope to "*" when missing
  if (toolName === 'memory_query' && !('scope' in args)) {
    args['scope'] = '*';
  }

  // 6. Normalize branch wildcard values
  if ('branch' in args && typeof args['branch'] === 'string') {
    if (SCOPE_WILDCARDS.has(args['branch'].toLowerCase())) {
      args['branch'] = '*';
    }
  }

  return args;
}
