// Pure text analysis: stemming, keyword extraction, similarity, filter parsing.
// Stateless — all functions are pure. No I/O, no side effects.
//
// Design: this module is the seam for future search strategies.
// v1: keyword matching with naive stemming (this file)
// v2: spreading activation over a knowledge graph
// v3: embedding-based cosine similarity

// Stopwords for keyword extraction — common English words with no semantic value
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
  'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same',
  'than', 'too', 'very', 'just', 'because', 'if', 'when', 'where',
  'how', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
  'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'about',
  'up', 'out', 'then', 'also', 'use', 'used', 'using',
]);

/** Parsed filter group: required, excluded, exact-match, and tag terms */
export interface FilterGroup {
  readonly must: Set<string>;
  readonly mustNot: Set<string>;
  readonly mustExact: Set<string>;  // =term: exact match, no stemming
  readonly mustTags: Set<string>;   // #tag: exact match against entry tags
}

/** Query mode summary — describes what a parsed filter actually searches */
export type QueryMode =
  | { readonly kind: 'no-filter' }
  | { readonly kind: 'keyword-only'; readonly terms: readonly string[] }
  | { readonly kind: 'tag-only'; readonly tags: readonly string[] }
  | { readonly kind: 'complex'; readonly hasTags: boolean; readonly hasExact: boolean; readonly hasNot: boolean; readonly hasOr: boolean };

/** Analyze parsed filter groups into QueryMode for display — pure function.
 *  Accepts already-parsed FilterGroup[] to avoid reparsing. */
export function analyzeFilterGroups(groups: readonly FilterGroup[]): QueryMode {
  if (groups.length === 0) return { kind: 'no-filter' };
  
  // Aggregate all filter features across OR groups
  const allMust = new Set<string>();
  const allMustNot = new Set<string>();
  const allMustExact = new Set<string>();
  const allMustTags = new Set<string>();
  
  for (const g of groups) {
    for (const t of g.must) allMust.add(t);
    for (const t of g.mustNot) allMustNot.add(t);
    for (const t of g.mustExact) allMustExact.add(t);
    for (const t of g.mustTags) allMustTags.add(t);
  }
  
  const hasTags = allMustTags.size > 0;
  const hasExact = allMustExact.size > 0;
  const hasNot = allMustNot.size > 0;
  const hasOr = groups.length > 1;
  const hasKeywords = allMust.size > 0;
  
  // Pure tag-only (no other features)
  if (hasTags && !hasExact && !hasNot && !hasOr && !hasKeywords) {
    return { kind: 'tag-only', tags: [...allMustTags] };
  }
  
  // Pure keyword-only (no other features)
  if (hasKeywords && !hasTags && !hasExact && !hasNot && !hasOr) {
    return { kind: 'keyword-only', terms: [...allMust] };
  }
  
  // Everything else is complex (mixed features)
  return { kind: 'complex', hasTags, hasExact, hasNot, hasOr };
}

/** Naive stem: strip common English suffixes to improve keyword matching.
 *  "reducers" -> "reducer", "sealed" stays, "implementations" -> "implement" */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  // Order matters: longest suffixes first
  if (word.endsWith('ations')) return word.slice(0, -6);
  if (word.endsWith('tion')) return word.slice(0, -4);
  if (word.endsWith('ment')) return word.slice(0, -4);
  if (word.endsWith('ness')) return word.slice(0, -4);
  if (word.endsWith('ings')) return word.slice(0, -4);
  if (word.endsWith('ally')) return word.slice(0, -4);
  if (word.endsWith('ing')) return word.slice(0, -3);
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ers')) return word.slice(0, -1);
  if (word.endsWith('ted')) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 4) return word.slice(0, -1);
  return word;
}

/** Extract significant keywords from text, with naive stemming.
 *  Hyphenated words produce both the compound and its parts:
 *  "memory-mcp" -> ["memory-mcp", "memory", "mcp"] */
export function extractKeywords(text: string): Set<string> {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')   // strip punctuation
    .split(/\s+/)
    .filter(w => w.length > 2)          // skip tiny words
    .filter(w => !STOPWORDS.has(w));

  // Expand hyphenated words: keep compound + add individual parts
  const expanded: string[] = [];
  for (const w of words) {
    expanded.push(w);
    if (w.includes('-')) {
      for (const part of w.split('-')) {
        if (part.length > 2 && !STOPWORDS.has(part)) {
          expanded.push(part);
        }
      }
    }
  }

  return new Set(expanded.map(w => stem(w)));
}

/** Jaccard similarity: |intersection| / |union| */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Containment similarity: |intersection| / min(|a|, |b|)
 *  Catches when one entry is a subset of a larger one */
export function containmentSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

/** Combined similarity: max(jaccard, containment) with title boost.
 *  Title keywords get double weight by being included twice. */
export function similarity(
  titleA: string, contentA: string,
  titleB: string, contentB: string,
): number {
  // Title keywords counted twice (implicit weight boost)
  const kwA = extractKeywords(`${titleA} ${titleA} ${contentA}`);
  const kwB = extractKeywords(`${titleB} ${titleB} ${contentB}`);
  const jaccard = jaccardSimilarity(kwA, kwB);
  const containment = containmentSimilarity(kwA, kwB);
  return Math.max(jaccard, containment);
}

/** Parse a filter string into OR groups of AND/NOT terms.
 *  "reducer sealed|MVI -deprecated" -> [
 *    { must: ["reducer", "seal"], mustNot: [] },
 *    { must: ["mvi"], mustNot: ["deprecat"] }
 *  ] */
export function parseFilter(filter: string): FilterGroup[] {
  const orGroups = filter.split('|').map(g => g.trim()).filter(g => g.length > 0);
  if (orGroups.length === 0) return [];

  return orGroups.map(group => {
    const terms = group.split(/\s+/).filter(t => t.length > 0);
    const must = new Set<string>();
    const mustNot = new Set<string>();
    const mustExact = new Set<string>();
    const mustTags = new Set<string>();

    for (const term of terms) {
      if (term.startsWith('-') && term.length > 1) {
        // Negation: stem the compound as-is, WITHOUT hyphen expansion.
        // "-memory-mcp" excludes the compound "memory-mcp" only,
        // not standalone "memory" or "mcp".
        const raw = term.slice(1).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (raw.length > 2) mustNot.add(stem(raw));
      } else if (term.startsWith('#') && term.length > 1) {
        // Tag filter: exact match against entry tags, no stemming
        mustTags.add(term.slice(1).toLowerCase());
      } else if (term.startsWith('=') && term.length > 1) {
        // Exact keyword match: bypasses stemming
        mustExact.add(term.slice(1).toLowerCase());
      } else {
        // Positive terms: full expansion (hyphens split into parts)
        for (const kw of extractKeywords(term)) {
          must.add(kw);
        }
      }
    }
    return { must, mustNot, mustExact, mustTags };
  });
}

/** Check if a set of keywords matches a filter string using stemmed AND/OR/NOT logic.
 *  Entry matches if ANY OR-group is satisfied (all must-terms present, no mustNot-terms present).
 *  Supports =exact (no stemming) and #tag (exact match against entry tags). */
export function matchesFilter(allKeywords: Set<string>, filter: string, tags?: readonly string[]): boolean {
  const groups = parseFilter(filter);
  if (groups.length === 0) return true;

  const entryTags = new Set(tags ?? []);

  return groups.some(({ must, mustNot, mustExact, mustTags }) => {
    for (const term of must) {
      if (!allKeywords.has(term)) return false;
    }
    for (const term of mustNot) {
      if (allKeywords.has(term)) return false;
    }
    for (const term of mustExact) {
      if (!allKeywords.has(term)) return false;
    }
    for (const tag of mustTags) {
      if (!entryTags.has(tag)) return false;
    }
    return must.size > 0 || mustNot.size > 0 || mustExact.size > 0 || mustTags.size > 0;
  });
}

/** Compute relevance score for an entry against a filter.
 *  Title matches get 2x weight over content-only matches.
 *  Tag and exact matches count as full-weight hits (same as title). */
export function computeRelevanceScore(
  titleKeywords: Set<string>,
  contentKeywords: Set<string>,
  confidence: number,
  filter: string,
  tags?: readonly string[],
): number {
  const groups = parseFilter(filter);
  if (groups.length === 0) return 0;

  const entryTags = new Set(tags ?? []);
  let bestScore = 0;

  for (const { must, mustExact, mustTags } of groups) {
    const totalTerms = must.size + mustExact.size + mustTags.size;
    if (totalTerms === 0) continue;
    let score = 0;
    for (const term of must) {
      if (titleKeywords.has(term)) {
        score += 2.0;  // title match = 2x weight
      } else if (contentKeywords.has(term)) {
        score += 1.0;  // content-only match
      }
    }
    for (const term of mustExact) {
      if (titleKeywords.has(term)) {
        score += 2.0;
      } else if (contentKeywords.has(term)) {
        score += 1.0;
      }
    }
    // Tag matches count as high-value (same as title hits)
    for (const tag of mustTags) {
      if (entryTags.has(tag)) score += 2.0;
    }
    const normalized = score / totalTerms;
    if (normalized > bestScore) bestScore = normalized;
  }

  return bestScore * confidence;
}
