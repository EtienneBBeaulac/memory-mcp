// Argument normalization for MCP tool calls.
//
// Agents frequently guess wrong param names. This module resolves common aliases
// and applies defaults to avoid wasted round-trips from validation errors.
// Pure functions — no side effects, no state.

/** Canonical param name aliases — maps guessed names to their correct form */
const PARAM_ALIASES: Record<string, string> = {
  // memory_store aliases
  key: 'title',
  name: 'title',
  value: 'content',
  body: 'content',
  text: 'content',
  refs: 'references',
  // memory_query aliases
  query: 'filter',
  search: 'filter',
  keyword: 'filter',
  // memory_context aliases
  description: 'context',
  task: 'context',
  // tag aliases
  tag: 'tags',
  labels: 'tags',
  categories: 'tags',
  // lobe aliases
  workspace: 'lobe',
  repo: 'lobe',
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

  // 1. Resolve param aliases (move aliased keys to canonical names)
  for (const [alias, canonical] of Object.entries(PARAM_ALIASES)) {
    if (alias in args && !(canonical in args)) {
      args[canonical] = args[alias];
      delete args[alias];
    }
  }

  // 2. For memory_store: accept "scope" as alias for "topic"
  if (toolName === 'memory_store' && 'scope' in args && !('topic' in args)) {
    args['topic'] = args['scope'];
    delete args['scope'];
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
