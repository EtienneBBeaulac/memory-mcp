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

/** Parsed filter group: a set of required terms and excluded terms */
export interface FilterGroup {
  readonly must: Set<string>;
  readonly mustNot: Set<string>;
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

    for (const term of terms) {
      if (term.startsWith('-') && term.length > 1) {
        // Negation: stem the compound as-is, WITHOUT hyphen expansion.
        // "-memory-mcp" excludes the compound "memory-mcp" only,
        // not standalone "memory" or "mcp".
        const raw = term.slice(1).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (raw.length > 2) mustNot.add(stem(raw));
      } else {
        // Positive terms: full expansion (hyphens split into parts)
        for (const kw of extractKeywords(term)) {
          must.add(kw);
        }
      }
    }
    return { must, mustNot };
  });
}

/** Check if a set of keywords matches a filter string using stemmed AND/OR/NOT logic.
 *  Entry matches if ANY OR-group is satisfied (all must-terms present, no mustNot-terms present). */
export function matchesFilter(allKeywords: Set<string>, filter: string): boolean {
  const groups = parseFilter(filter);
  if (groups.length === 0) return true;

  return groups.some(({ must, mustNot }) => {
    for (const term of must) {
      if (!allKeywords.has(term)) return false;
    }
    for (const term of mustNot) {
      if (allKeywords.has(term)) return false;
    }
    return must.size > 0 || mustNot.size > 0;
  });
}

/** Compute relevance score for an entry against a filter.
 *  Title matches get 2x weight over content-only matches. */
export function computeRelevanceScore(
  titleKeywords: Set<string>,
  contentKeywords: Set<string>,
  confidence: number,
  filter: string,
): number {
  const groups = parseFilter(filter);
  if (groups.length === 0) return 0;

  let bestScore = 0;

  for (const { must } of groups) {
    if (must.size === 0) continue;
    let score = 0;
    for (const term of must) {
      if (titleKeywords.has(term)) {
        score += 2.0;  // title match = 2x weight
      } else if (contentKeywords.has(term)) {
        score += 1.0;  // content-only match
      }
    }
    const normalized = score / must.size;
    if (normalized > bestScore) bestScore = normalized;
  }

  return bestScore * confidence;
}
