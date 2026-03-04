// Pure lobe resolution logic — extracted for testability.
//
// When the agent doesn't specify a lobe, we determine which lobe(s) to search
// via a degradation ladder:
//   1. Single lobe configured → use it (unambiguous)
//   2. Multiple lobes → match client workspace roots against lobe repo roots
//   3. Fallback → global-only with a hint to specify the lobe
//
// This prevents cross-lobe leakage (e.g. game design lore surfacing in an Android MR review).

import path from 'path';

/** Outcome of resolving which lobes to search when the agent didn't specify one. */
export type LobeResolution =
  | { readonly kind: 'resolved'; readonly lobes: readonly string[]; readonly label: string }
  | { readonly kind: 'global-only'; readonly hint: string };

/** A root URI from the MCP client (e.g. "file:///Users/me/projects/zillow"). */
export interface ClientRoot {
  readonly uri: string;
}

/** Minimal lobe config needed for matching — just the repo root path. */
export interface LobeRootConfig {
  readonly name: string;
  readonly repoRoot: string;
}

/** Check if `child` is equal to or nested under `parent` with path-boundary awareness.
 *  Prevents false matches like "/projects/zillow-tools" matching "/projects/zillow". */
function isPathPrefixOf(parent: string, child: string): boolean {
  if (child === parent) return true;
  // Ensure the prefix ends at a path separator boundary
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/** Match MCP client workspace root URIs against known lobe repo roots.
 *  Returns matched lobe names, or empty array if none match.
 *
 *  Matching rules:
 *  - file:// URIs are stripped to filesystem paths
 *  - Both paths are normalized via path.resolve
 *  - A match occurs when either path is equal to or nested inside the other,
 *    checked at path-separator boundaries (no partial-name false positives) */
export function matchRootsToLobeNames(
  clientRoots: readonly ClientRoot[],
  lobeConfigs: readonly LobeRootConfig[],
): readonly string[] {
  if (clientRoots.length === 0 || lobeConfigs.length === 0) return [];

  const matchedLobes = new Set<string>();

  for (const root of clientRoots) {
    // MCP roots use file:// URIs — strip the scheme to get the filesystem path
    const rootPath = root.uri.startsWith('file://') ? root.uri.slice(7) : root.uri;
    const normalizedRoot = path.resolve(rootPath);

    for (const lobe of lobeConfigs) {
      const normalizedLobe = path.resolve(lobe.repoRoot);

      // Match if one path is equal to or nested inside the other
      if (isPathPrefixOf(normalizedLobe, normalizedRoot) || isPathPrefixOf(normalizedRoot, normalizedLobe)) {
        matchedLobes.add(lobe.name);
      }
    }
  }

  return Array.from(matchedLobes);
}

/** Build a LobeResolution from the available lobe names and matched lobes.
 *  Encodes the degradation ladder as a pure function. */
export function buildLobeResolution(
  allLobeNames: readonly string[],
  matchedLobes: readonly string[],
): LobeResolution {
  // Single lobe — always resolved, regardless of root matching
  if (allLobeNames.length === 1) {
    return { kind: 'resolved', lobes: allLobeNames, label: allLobeNames[0] };
  }

  // Multiple lobes with successful root match
  if (matchedLobes.length > 0) {
    return {
      kind: 'resolved',
      lobes: matchedLobes,
      label: matchedLobes.length === 1 ? matchedLobes[0] : matchedLobes.join('+'),
    };
  }

  // Fallback — no lobes could be determined
  return {
    kind: 'global-only',
    hint: `Multiple lobes available (${allLobeNames.join(', ')}) but none could be inferred from client workspace roots. ` +
      `Specify lobe parameter for lobe-specific results.`,
  };
}
