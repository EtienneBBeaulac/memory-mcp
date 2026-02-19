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
  readonly sources: readonly string[]; // file paths that informed this
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
  readonly storageSize: string;
  readonly storageBudgetBytes: number;
  readonly memoryPath: string;
  readonly oldestEntry?: string;
  readonly newestEntry?: string;
}

/** Briefing response for session start */
export interface BriefingResult {
  readonly briefing: string;
  readonly entryCount: number;
  readonly staleEntries: number;
  readonly suggestion?: string;
}

/** Git operations boundary — injected to keep core logic testable and swappable */
export interface GitService {
  getCurrentBranch(repoRoot: string): Promise<string>;
  getHeadSha(repoRoot: string): Promise<string | undefined>;
}

/** Configuration for the memory MCP */
export interface MemoryConfig {
  readonly repoRoot: string;          // path to the target repository
  readonly memoryPath: string;        // absolute path to the memory storage directory
  readonly storageBudgetBytes: number; // default: 2MB
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
