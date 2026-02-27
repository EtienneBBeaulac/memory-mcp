// Core types for the codebase memory MCP
//
// Design principles:
//   - Make illegal states unrepresentable: discriminated unions over boolean+optional
//   - Validate at boundaries, trust inside: parse functions at system edges
//   - Explicit domain types over primitives where meaning matters

/** Trust levels for knowledge sources, ordered by reliability */
export type TrustLevel = 'user' | 'agent-confirmed' | 'agent-inferred';

const TRUST_LEVELS: readonly TrustLevel[] = ['user', 'agent-confirmed', 'agent-inferred'];

/** Parse a raw string into a TrustLevel, returning null for invalid input */
export function parseTrustLevel(raw: string): TrustLevel | null {
  return TRUST_LEVELS.includes(raw as TrustLevel) ? raw as TrustLevel : null;
}

/** Predefined topic scopes for organizing knowledge */
export type TopicScope =
  | 'user'
  | 'preferences'
  | 'architecture'
  | 'conventions'
  | 'gotchas'
  | 'recent-work'
  | `modules/${string}`;

const FIXED_TOPICS: readonly string[] = ['user', 'preferences', 'architecture', 'conventions', 'gotchas', 'recent-work'];

/** Validated tag: lowercase alphanumeric slug (letters, digits, hyphens).
 *  Branded type prevents accidentally passing raw strings where validated tags are expected. */
export type Tag = string & { readonly __brand: 'Tag' };

const TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_ENTRY = 10;

/** Parse a raw string into a Tag, returning null for invalid input.
 *  Normalizes to lowercase. Rejects empty, too-long, or non-slug strings. */
export function parseTag(raw: string): Tag | null {
  const normalized = raw.trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')  // non-slug chars → dash
    .replace(/-+/g, '-')           // collapse consecutive dashes
    .replace(/^-|-$/g, '');        // trim leading/trailing dashes
  if (normalized.length < 2 || normalized.length > MAX_TAG_LENGTH) return null;
  if (!TAG_PATTERN.test(normalized)) return null;
  return normalized as Tag;
}

/** Parse an array of raw strings into Tags, silently dropping invalid/duplicate ones.
 *  Caps at MAX_TAGS_PER_ENTRY to prevent sprawl. */
export function parseTags(raw: readonly string[]): readonly Tag[] {
  const tags: Tag[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const tag = parseTag(r);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length >= MAX_TAGS_PER_ENTRY) break;
  }
  return tags;
}

/** Parse a raw string into a TopicScope, returning null for invalid input */
export function parseTopicScope(raw: string): TopicScope | null {
  if (FIXED_TOPICS.includes(raw)) return raw as TopicScope;
  if (raw.startsWith('modules/') && raw.length > 8) return raw as TopicScope;
  return null;
}

/** Injectable clock for deterministic time in tests */
export interface Clock {
  now(): Date;
  isoNow(): string;
}

/** Production clock using real wall time */
export const realClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
};

/** A single knowledge entry stored in the memory system */
export interface MemoryEntry {
  readonly id: string;
  readonly topic: TopicScope;
  readonly title: string;
  readonly content: string;
  readonly confidence: number;       // 0.0 - 1.0
  readonly trust: TrustLevel;
  readonly sources: readonly string[]; // file paths that informed this (provenance)
  readonly references?: readonly string[]; // semantic pointers — files/classes this entry is about
  readonly tags?: readonly Tag[];      // user-defined labels for exact-match retrieval
  readonly created: string;           // ISO 8601
  readonly lastAccessed: string;      // ISO 8601
  readonly gitSha?: string;           // SHA of source files at write time
  readonly branch?: string;           // git branch name (primarily for recent-work)
}

/** In-memory index entry for fast lookups */
export interface IndexEntry {
  readonly id: string;
  readonly topic: TopicScope;
  readonly title: string;
  readonly confidence: number;
  readonly trust: TrustLevel;
  readonly created: string;
  readonly lastAccessed: string;
  readonly file: string;             // relative path within memory dir
  readonly branch?: string;
}

/** Detail levels for query responses */
export type DetailLevel = 'brief' | 'standard' | 'full';

/** Result of a memory query */
export interface QueryResult {
  readonly scope: string;
  readonly detail: DetailLevel;
  readonly entries: readonly QueryEntry[];
  readonly totalEntries: number;
}

export interface QueryEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;          // brief: 1-line, standard: paragraph, full: everything
  readonly confidence: number;
  readonly relevanceScore: number;   // title-weighted relevance when filtered, else confidence
  readonly fresh: boolean;
  // In 'standard' and 'full' detail
  readonly references?: readonly string[];
  readonly tags?: readonly Tag[];
  // Only in 'full' detail
  readonly content?: string;
  readonly trust?: TrustLevel;
  readonly sources?: readonly string[];
  readonly created?: string;
  readonly lastAccessed?: string;
  readonly gitSha?: string;
  readonly branch?: string;
}

/** A related entry surfaced during dedup detection */
export interface RelatedEntry {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly confidence: number;
  readonly trust: TrustLevel;
}

/** Result of a memory store operation — discriminated union eliminates impossible states */
export type StoreResult =
  | {
      readonly stored: true;
      readonly id: string;
      readonly topic: TopicScope;
      readonly file: string;
      readonly confidence: number;
      readonly warning?: string;
      /** Soft warning when content looks ephemeral — informational, never blocking */
      readonly ephemeralWarning?: string;
      readonly relatedEntries?: readonly RelatedEntry[];
      readonly relevantPreferences?: readonly RelatedEntry[];
    }
  | {
      readonly stored: false;
      readonly topic: TopicScope;
      readonly warning: string;
    };

/** Result of a memory correction — discriminated union eliminates impossible states */
export type CorrectResult =
  | {
      readonly corrected: true;
      readonly id: string;
      readonly action: 'append' | 'replace' | 'delete';
      readonly newConfidence: number;
      readonly trust: TrustLevel;
    }
  | {
      readonly corrected: false;
      readonly id: string;
      readonly error: string;
    };

/** Memory health statistics */
export interface MemoryStats {
  readonly totalEntries: number;
  readonly corruptFiles: number;
  readonly byTopic: Record<string, number>;
  readonly byTrust: Record<TrustLevel, number>;
  readonly byFreshness: { fresh: number; stale: number; unknown: number };
  readonly byTag: Record<string, number>;
  readonly storageSize: string;
  readonly storageBudgetBytes: number;
  readonly memoryPath: string;
  readonly oldestEntry?: string;
  readonly newestEntry?: string;
}

/** A stale entry surfaced during briefing for agent-driven renewal */
export interface StaleEntry {
  readonly id: string;
  readonly title: string;
  readonly topic: TopicScope;
  readonly daysSinceAccess: number;
}

/** A pair of entries with high content overlap — potential conflict */
export interface ConflictPair {
  readonly a: { readonly id: string; readonly title: string; readonly confidence: number; readonly created: string };
  readonly b: { readonly id: string; readonly title: string; readonly confidence: number; readonly created: string };
  readonly similarity: number;
}

/** Briefing response for session start */
export interface BriefingResult {
  readonly briefing: string;
  readonly entryCount: number;
  readonly staleEntries: number;
  readonly staleDetails?: readonly StaleEntry[]; // structured stale data for index.ts to format
  readonly suggestion?: string;
}

/** Git operations boundary — injected to keep core logic testable and swappable */
export interface GitService {
  getCurrentBranch(repoRoot: string): Promise<string>;
  getHeadSha(repoRoot: string): Promise<string | undefined>;
}

/** User-configurable behavior thresholds — exposed via memory-config.json "behavior" block.
 *  All fields are optional; the system uses the defaults from thresholds.ts when absent. */
export interface BehaviorConfig {
  /** Days since lastAccessed before a standard entry (arch, conv, gotchas, etc.) goes stale.
   *  Lower for fast-moving codebases; higher for stable ones. Default: 30. Range: 1–365. */
  readonly staleDaysStandard?: number;
  /** Days since lastAccessed before a preferences entry goes stale.
   *  Preferences evolve slowly — default 90 keeps them fresh longer. Range: 1–730. */
  readonly staleDaysPreferences?: number;
  /** Maximum stale entries shown in a briefing. Default: 5. Range: 1–20. */
  readonly maxStaleInBriefing?: number;
  /** Maximum dedup suggestions when storing a new entry. Default: 3. Range: 1–10. */
  readonly maxDedupSuggestions?: number;
  /** Maximum conflict pairs shown per query/context response. Default: 2. Range: 1–5. */
  readonly maxConflictPairs?: number;
}

/** Configuration for the memory MCP */
export interface MemoryConfig {
  readonly repoRoot: string;          // path to the target repository
  readonly memoryPath: string;        // absolute path to the memory storage directory
  readonly storageBudgetBytes: number; // default: 2MB
  readonly behavior?: BehaviorConfig; // user-facing behavior thresholds
  readonly clock?: Clock;             // injectable clock for testing; defaults to realClock
  readonly git?: GitService;          // injectable git service; defaults to realGitService
}

/** Default confidence values by trust level */
export const DEFAULT_CONFIDENCE: Record<TrustLevel, number> = {
  'user': 1.0,
  'agent-confirmed': 0.85,
  'agent-inferred': 0.70,
};

/** Storage budget: 2MB */
export const DEFAULT_STORAGE_BUDGET_BYTES = 2 * 1024 * 1024;
