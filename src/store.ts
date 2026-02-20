// Markdown-backed memory store — one file per entry
// Concurrency-safe: no two processes write the same file (except corrections)
// Worktree-safe: shared storage via .git common dir, branch-scoped recent-work

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  MemoryEntry, TopicScope, TrustLevel, DetailLevel,
  QueryResult, QueryEntry, StoreResult, CorrectResult, MemoryStats,
  BriefingResult, StaleEntry, ConflictPair, MemoryConfig, RelatedEntry, Clock, GitService,
} from './types.js';
import { DEFAULT_CONFIDENCE, realClock, parseTopicScope, parseTrustLevel } from './types.js';
import {
  DEDUP_SIMILARITY_THRESHOLD,
  CONFLICT_SIMILARITY_THRESHOLD_SAME_TOPIC,
  CONFLICT_SIMILARITY_THRESHOLD_CROSS_TOPIC,
  CONFLICT_MIN_CONTENT_CHARS,
  OPPOSITION_PAIRS,
  PREFERENCE_SURFACE_THRESHOLD,
  REFERENCE_BOOST_MULTIPLIER,
  TOPIC_BOOST,
  MODULE_TOPIC_BOOST,
  USER_ALWAYS_INCLUDE_SCORE_FRACTION,
  DEFAULT_STALE_DAYS_STANDARD,
  DEFAULT_STALE_DAYS_PREFERENCES,
  DEFAULT_MAX_STALE_IN_BRIEFING,
  DEFAULT_MAX_DEDUP_SUGGESTIONS,
  DEFAULT_MAX_CONFLICT_PAIRS,
  DEFAULT_MAX_PREFERENCE_SUGGESTIONS,
} from './thresholds.js';
import { realGitService } from './git-service.js';
import {
  extractKeywords, stem, similarity, matchesFilter, computeRelevanceScore,
} from './text-analyzer.js';
import { detectEphemeralSignals, formatEphemeralWarning } from './ephemeral.js';

// Used only by bootstrap() for git log — not part of the GitService boundary
// because bootstrap is a one-shot utility, not a recurring operation
const execFileAsync = promisify(execFile);

export class MarkdownMemoryStore {
  private readonly config: MemoryConfig;
  private readonly memoryPath: string;
  private readonly clock: Clock;
  private readonly git: GitService;
  private entries: Map<string, MemoryEntry> = new Map();
  private corruptFileCount: number = 0;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.memoryPath = config.memoryPath;
    this.clock = config.clock ?? realClock;
    this.git = config.git ?? realGitService;
  }

  /** Resolved behavior thresholds — user config merged over defaults.
   *  Centralizes threshold resolution so every caller gets the same value. */
  private get behavior() {
    const b = this.config.behavior ?? {};
    return {
      staleDaysStandard: b.staleDaysStandard ?? DEFAULT_STALE_DAYS_STANDARD,
      staleDaysPreferences: b.staleDaysPreferences ?? DEFAULT_STALE_DAYS_PREFERENCES,
      maxStaleInBriefing: b.maxStaleInBriefing ?? DEFAULT_MAX_STALE_IN_BRIEFING,
      maxDedupSuggestions: b.maxDedupSuggestions ?? DEFAULT_MAX_DEDUP_SUGGESTIONS,
      maxConflictPairs: b.maxConflictPairs ?? DEFAULT_MAX_CONFLICT_PAIRS,
    };
  }

  /** Initialize the store: create memory dir and load existing entries */
  async init(): Promise<void> {
    await fs.mkdir(this.memoryPath, { recursive: true });
    await this.reloadFromDisk();
  }

  /** Store a new knowledge entry */
  async store(
    topic: TopicScope,
    title: string,
    content: string,
    sources: string[] = [],
    trust: TrustLevel = 'agent-inferred',
    references: string[] = [],
  ): Promise<StoreResult> {
    // Check storage budget — null means we can't measure, allow the write
    const currentSize = await this.getStorageSize();
    if (currentSize !== null && currentSize >= this.config.storageBudgetBytes) {
      return {
        stored: false, topic,
        warning: `Storage budget exceeded (${this.formatBytes(currentSize)} / ${this.formatBytes(this.config.storageBudgetBytes)}). Delete or correct existing entries to free space.`,
      };
    }

    const id = this.generateId(topic);
    const now = this.clock.isoNow();
    const confidence = DEFAULT_CONFIDENCE[trust];
    const gitSha = await this.getGitSha(sources);

    // Auto-detect branch for recent-work entries
    const branch = topic === 'recent-work' ? await this.getCurrentBranch() : undefined;

    const entry: MemoryEntry = {
      id, topic, title, content, confidence, trust,
      sources,
      references: references.length > 0 ? references : undefined,
      created: now, lastAccessed: now, gitSha, branch,
    };

    // Check for existing entry with same title in same topic (and same branch for recent-work)
    const existing = Array.from(this.entries.values())
      .find(e => e.topic === topic && e.title === title && (topic !== 'recent-work' || e.branch === branch));
    const warning = existing
      ? `Overwrote existing entry '${title}' (id: ${existing.id}).`
      : undefined;

    if (existing) {
      await this.deleteEntryFile(existing);
      this.entries.delete(existing.id);
    }

    // Store entry in memory and on disk
    this.entries.set(id, entry);
    const file = this.entryToRelativePath(entry);
    await this.persistEntry(entry);

    // Dedup: find related entries in the same topic (excluding the one just stored and any overwritten)
    const relatedEntries = this.findRelatedEntries(entry, existing?.id);

    // Surface relevant preferences if storing a non-preference entry
    const relevantPreferences = (topic !== 'preferences' && topic !== 'user')
      ? this.findRelevantPreferences(entry)
      : undefined;

    // Soft ephemeral detection — warn but never block
    const ephemeralSignals = topic !== 'recent-work'
      ? detectEphemeralSignals(title, content, topic)
      : [];
    const ephemeralWarning = formatEphemeralWarning(ephemeralSignals);

    return {
      stored: true, id, topic, file, confidence, warning, ephemeralWarning,
      relatedEntries: relatedEntries.length > 0 ? relatedEntries : undefined,
      relevantPreferences: relevantPreferences && relevantPreferences.length > 0 ? relevantPreferences : undefined,
    };
  }

  /** Query knowledge by scope and detail level */
  async query(
    scope: string,
    detail: DetailLevel = 'brief',
    filter?: string,
    branchFilter?: string
  ): Promise<QueryResult> {
    // Reload from disk to pick up changes from other processes
    await this.reloadFromDisk();

    const currentBranch = await this.getCurrentBranch();

    const matching = Array.from(this.entries.values()).filter(entry => {
      // Scope matching
      if (scope !== '*' && entry.topic !== scope) {
        if (!entry.topic.startsWith(scope + '/') && entry.topic !== scope) {
          return false;
        }
      }

      // Branch filtering for recent-work: default to current branch
      // branchFilter: undefined = current branch, '*' = all branches, 'name' = specific branch
      if (entry.topic === 'recent-work' && branchFilter !== '*') {
        const targetBranch = branchFilter ?? currentBranch;
        if (targetBranch && entry.branch && entry.branch !== targetBranch) {
          return false;
        }
      }

      // Optional keyword filter with AND/OR/NOT syntax
      if (filter) {
        const titleKeywords = extractKeywords(entry.title);
        const contentKeywords = extractKeywords(entry.content);
        const allKeywords = new Set([...titleKeywords, ...contentKeywords]);
        return matchesFilter(allKeywords, filter);
      }
      return true;
    });

    // Sort by relevance score (title-weighted), then confidence, then recency
    if (filter) {
      const scores = new Map<string, number>();
      for (const entry of matching) {
        scores.set(entry.id, computeRelevanceScore(
          extractKeywords(entry.title),
          extractKeywords(entry.content),
          entry.confidence,
          filter,
        ));
      }
      matching.sort((a, b) => {
        const scoreDiff = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
        if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime();
      });
    } else {
      matching.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime();
      });
    }

    // Update lastAccessed for queried entries
    const now = this.clock.isoNow();
    for (const entry of matching) {
      const updated = { ...entry, lastAccessed: now };
      this.entries.set(entry.id, updated);
      // Fire-and-forget persist — don't block the query
      this.persistEntry(updated).catch(() => {});
    }

    const entries: QueryEntry[] = matching.map(entry => ({
      ...this.formatEntry(entry, detail),
      relevanceScore: filter
        ? computeRelevanceScore(extractKeywords(entry.title), extractKeywords(entry.content), entry.confidence, filter)
        : entry.confidence,
    }));

    return { scope, detail, entries, totalEntries: matching.length };
  }

  /** Generate a session-start briefing */
  async briefing(maxTokens: number = 200): Promise<BriefingResult> {
    // Reload from disk to pick up changes from other processes
    await this.reloadFromDisk();

    if (this.entries.size === 0) {
      return {
        briefing: 'No knowledge stored yet. Use memory_store to save observations, or memory_bootstrap to scan the codebase.',
        entryCount: 0, staleEntries: 0,
        suggestion: 'Try memory_bootstrap to seed initial knowledge from the codebase structure.',
      };
    }

    const currentBranch = await this.getCurrentBranch();
    const allEntries = Array.from(this.entries.values());
    const staleCount = allEntries.filter(e => !this.isFresh(e)).length;

    // Group by topic, filter recent-work by current branch
    const byTopic = new Map<string, MemoryEntry[]>();
    for (const entry of allEntries) {
      // Skip recent-work from other branches
      if (entry.topic === 'recent-work' && entry.branch && entry.branch !== currentBranch) {
        continue;
      }
      const list = byTopic.get(entry.topic) ?? [];
      list.push(entry);
      byTopic.set(entry.topic, list);
    }

    // Priority order: user > preferences > gotchas > architecture > conventions > modules > recent-work
    const topicOrder: string[] = ['user', 'preferences', 'gotchas', 'architecture', 'conventions'];
    const moduleTopics = Array.from(byTopic.keys()).filter(t => t.startsWith('modules/')).sort();
    topicOrder.push(...moduleTopics, 'recent-work');

    const sections: string[] = [];
    let estimatedTokens = 0;

    for (const topic of topicOrder) {
      const topicEntries = byTopic.get(topic);
      if (!topicEntries || topicEntries.length === 0) continue;

      const heading = topic === 'user' ? 'About You'
        : topic === 'preferences' ? 'Your Preferences'
        : topic === 'gotchas' ? 'Active Gotchas'
        : topic === 'recent-work' ? `Recent Work (${currentBranch})`
        : topic.startsWith('modules/') ? `Module: ${topic.split('/')[1]}`
        : topic.charAt(0).toUpperCase() + topic.slice(1);

      const lines = topicEntries
        .sort((a, b) => b.confidence - a.confidence)
        .map(e => {
          const staleMarker = this.isFresh(e) ? '' : ' [stale]';
          const gotchaMarker = topic === 'gotchas' ? '[!] ' : '';
          return `- ${gotchaMarker}${e.title}: ${this.summarize(e.content, 80)}${staleMarker}`;
        });

      const section = `### ${heading}\n${lines.join('\n')}`;
      const sectionTokens = Math.ceil(section.length / 4);

      if (estimatedTokens + sectionTokens > maxTokens && sections.length > 0) break;
      sections.push(section);
      estimatedTokens += sectionTokens;
    }

    const briefing = `## Session Briefing\n\n${sections.join('\n\n')}`;

    const recentWork = byTopic.get('recent-work');
    const suggestion = recentWork && recentWork.length > 0
      ? `Last session context available for branch "${currentBranch}". Try memory_query(scope: "recent-work", detail: "full") for details.`
      : undefined;

    // Collect stale details for the presentation layer (index.ts) to format.
    // Topic priority order: gotchas first (most dangerous when stale), then arch/conv/modules/recent-work.
    // User is never stale; preferences use a 90-day threshold so they'll appear here only when truly old.
    const STALE_TOPIC_PRIORITY: Record<string, number> = {
      gotchas: 0, architecture: 1, conventions: 2, 'recent-work': 4,
    };
    const staleDetails: StaleEntry[] = allEntries
      .filter(e => !this.isFresh(e))
      .map(e => ({
        id: e.id,
        title: e.title,
        topic: e.topic,
        daysSinceAccess: Math.floor(this.daysSinceAccess(e)),
      }))
      .sort((a, b) => {
        const pa = STALE_TOPIC_PRIORITY[a.topic] ?? (a.topic.startsWith('modules/') ? 3 : 5);
        const pb = STALE_TOPIC_PRIORITY[b.topic] ?? (b.topic.startsWith('modules/') ? 3 : 5);
        if (pa !== pb) return pa - pb;
        return b.daysSinceAccess - a.daysSinceAccess; // older entries first within same priority
      })
      .slice(0, this.behavior.maxStaleInBriefing); // cap to avoid overwhelming the agent

    return {
      briefing,
      entryCount: this.entries.size,
      staleEntries: staleCount,
      staleDetails: staleDetails.length > 0 ? staleDetails : undefined,
      suggestion,
    };
  }

  /** Correct an existing entry */
  async correct(
    id: string,
    correction: string,
    action: 'append' | 'replace' | 'delete'
  ): Promise<CorrectResult> {
    // Reload to ensure we have the latest
    await this.reloadFromDisk();

    const entry = this.entries.get(id);
    if (!entry) {
      return {
        corrected: false, id,
        error: `Entry not found: ${id}`,
      };
    }

    if (action === 'delete') {
      await this.deleteEntryFile(entry);
      this.entries.delete(id);
      return { corrected: true, id, action, newConfidence: 0, trust: 'user' };
    }

    const newContent = action === 'append'
      ? `${entry.content}\n\n${correction}`
      : correction;

    const updated: MemoryEntry = {
      ...entry,
      content: newContent,
      confidence: 1.0,
      trust: 'user',
      lastAccessed: this.clock.isoNow(),
    };

    this.entries.set(id, updated);
    await this.persistEntry(updated);

    return { corrected: true, id, action, newConfidence: 1.0, trust: 'user' };
  }

  /** Get memory health statistics */
  async stats(): Promise<MemoryStats> {
    await this.reloadFromDisk();

    const allEntries = Array.from(this.entries.values());
    const storageSize = await this.getStorageSize();

    const byTopic: Record<string, number> = {};
    const byTrust: Record<TrustLevel, number> = { 'user': 0, 'agent-confirmed': 0, 'agent-inferred': 0 };
    const byFreshness = { fresh: 0, stale: 0, unknown: 0 };

    for (const entry of allEntries) {
      byTopic[entry.topic] = (byTopic[entry.topic] ?? 0) + 1;
      byTrust[entry.trust]++;
      if (entry.sources.length === 0) {
        byFreshness.unknown++;
      } else if (this.isFresh(entry)) {
        byFreshness.fresh++;
      } else {
        byFreshness.stale++;
      }
    }

    const dates = allEntries.map(e => e.created).sort();

    return {
      totalEntries: allEntries.length,
      corruptFiles: this.corruptFileCount,
      byTopic, byTrust, byFreshness,
      storageSize: this.formatBytes(storageSize ?? 0),
      storageBudgetBytes: this.config.storageBudgetBytes,
      memoryPath: this.memoryPath,
      oldestEntry: dates[0],
      newestEntry: dates[dates.length - 1],
    };
  }

  /** Bootstrap: scan repo structure and seed initial knowledge */
  async bootstrap(): Promise<StoreResult[]> {
    const results: StoreResult[] = [];
    const repoRoot = this.config.repoRoot;

    // 1. Scan directory structure
    try {
      const topLevel = await fs.readdir(repoRoot, { withFileTypes: true });
      const dirs = topLevel
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => d.name);

      if (dirs.length > 0) {
        results.push(await this.store(
          'architecture', 'Repository Structure',
          `Top-level directories: ${dirs.join(', ')}`,
          [], 'agent-inferred'
        ));
      }
    } catch { /* ignore */ }

    // 2. Read README if it exists
    try {
      const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf-8');
      results.push(await this.store(
        'architecture', 'README Summary',
        this.summarize(readme, 500),
        ['README.md'], 'agent-inferred'
      ));
    } catch { /* no README */ }

    // 3. Detect build system / language
    const buildFiles: Array<{ file: string; meaning: string }> = [
      { file: 'package.json', meaning: 'Node.js/TypeScript project (npm)' },
      { file: 'Package.swift', meaning: 'Swift Package Manager project' },
      { file: 'build.gradle.kts', meaning: 'Kotlin/Gradle project' },
      { file: 'build.gradle', meaning: 'Java/Gradle project' },
      { file: 'Cargo.toml', meaning: 'Rust project (Cargo)' },
      { file: 'go.mod', meaning: 'Go module' },
      { file: 'pyproject.toml', meaning: 'Python project' },
      { file: 'Tuist.swift', meaning: 'iOS project managed by Tuist' },
    ];

    const detected: string[] = [];
    for (const { file, meaning } of buildFiles) {
      try {
        await fs.access(path.join(repoRoot, file));
        detected.push(meaning);
      } catch { /* not found */ }
    }

    if (detected.length > 0) {
      results.push(await this.store(
        'architecture', 'Build System & Language',
        `Detected: ${detected.join('; ')}`,
        detected.map(d => buildFiles.find(b => b.meaning === d)?.file ?? '').filter(Boolean),
        'agent-inferred'
      ));
    }

    // 4. Check git info
    try {
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '-5'], { cwd: repoRoot, timeout: 5000 });
      results.push(await this.store(
        'recent-work', 'Recent Git History',
        `Last 5 commits:\n${stdout.trim()}`,
        [], 'agent-inferred'
      ));
    } catch { /* not a git repo or git not available */ }

    return results;
  }

  // --- Contextual search (memory_context) ---

  /** Search across all topics using keyword matching with topic-based boosting.
   *  @param minMatch Minimum ratio of context keywords that must match (0-1, default 0.2) */
  async contextSearch(
    context: string,
    maxResults: number = 10,
    branchFilter?: string,
    minMatch: number = 0.2,
  ): Promise<Array<{ entry: MemoryEntry; score: number; matchedKeywords: string[] }>> {
    // Reload from disk to pick up changes from other processes
    await this.reloadFromDisk();

    const contextKeywords = extractKeywords(context);
    if (contextKeywords.size === 0) return [];

    const currentBranch = branchFilter || await this.getCurrentBranch();

    // Topic boost factors — higher = more likely to surface
    const topicBoost = TOPIC_BOOST;

    const results: Array<{ entry: MemoryEntry; score: number; matchedKeywords: string[] }> = [];

    for (const entry of this.entries.values()) {
      // Filter recent-work by branch (unless branchFilter is "*")
      if (entry.topic === 'recent-work' && branchFilter !== '*' && entry.branch && entry.branch !== currentBranch) {
        continue;
      }

      const entryKeywords = extractKeywords(`${entry.title} ${entry.content}`);
      const matchedKeywords: string[] = [];

      for (const kw of contextKeywords) {
        if (entryKeywords.has(kw)) matchedKeywords.push(kw);
      }

      if (matchedKeywords.length === 0) continue;

      // Enforce minimum match threshold
      const matchRatio = matchedKeywords.length / contextKeywords.size;
      if (matchRatio < minMatch) continue;

      // Score = keyword match ratio x confidence x topic boost x reference boost
      const boost = topicBoost[entry.topic] ?? (entry.topic.startsWith('modules/') ? MODULE_TOPIC_BOOST : 1.0);
      const freshnessMultiplier = this.isFresh(entry) ? 1.0 : 0.7;

      // Reference boost: exact class/file name match in references gets a 1.3x multiplier.
      // Extracts the basename (without extension) from each reference path and stems it,
      // then checks for overlap with the context keywords.
      const referenceBoost = entry.references?.some(ref => {
        const basename = ref.split('/').pop()?.replace(/\.\w+$/, '') ?? ref;
        return contextKeywords.has(stem(basename.toLowerCase()));
      }) ? REFERENCE_BOOST_MULTIPLIER : 1.0;

      const score = matchRatio * entry.confidence * boost * freshnessMultiplier * referenceBoost;

      results.push({ entry, score, matchedKeywords });
    }

    // Always include user entries even if no keyword match (they're always relevant)
    for (const entry of this.entries.values()) {
      if (entry.topic === 'user' && !results.find(r => r.entry.id === entry.id)) {
        results.push({ entry, score: entry.confidence * USER_ALWAYS_INCLUDE_SCORE_FRACTION, matchedKeywords: [] });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  // --- Private helpers ---

  /** Generate a collision-resistant ID: {prefix}-{8 random hex chars} */
  private generateId(topic: TopicScope): string {
    const prefix = topic.startsWith('modules/') ? 'mod' :
      topic === 'user' ? 'user' :
      topic === 'preferences' ? 'pref' :
      topic === 'architecture' ? 'arch' :
      topic === 'conventions' ? 'conv' :
      topic === 'gotchas' ? 'gotcha' :
      topic === 'recent-work' ? 'recent' : 'mem';
    const hex = crypto.randomBytes(4).toString('hex');
    return `${prefix}-${hex}`;
  }

  /** Compute relative file path for an entry within the memory directory */
  private entryToRelativePath(entry: MemoryEntry): string {
    if (entry.topic === 'recent-work' && entry.branch) {
      const branchSlug = this.sanitizeBranchName(entry.branch);
      return path.join('recent-work', branchSlug, `${entry.id}.md`);
    }
    return path.join(entry.topic, `${entry.id}.md`);
  }

  /** Sanitize git branch name for use as a directory name */
  private sanitizeBranchName(branch: string): string {
    return branch
      .replace(/[^a-zA-Z0-9._-]/g, '-')  // replace non-safe chars with dash
      .replace(/-+/g, '-')                 // collapse consecutive dashes
      .replace(/^-|-$/g, '')               // trim leading/trailing dashes
      || 'unknown';
  }

  /** Get the current git branch name — delegates to injected GitService */
  async getCurrentBranch(): Promise<string> {
    return this.git.getCurrentBranch(this.config.repoRoot);
  }

  /** Write a single entry to its own file */
  private async persistEntry(entry: MemoryEntry): Promise<void> {
    const relativePath = this.entryToRelativePath(entry);
    const fullPath = path.join(this.memoryPath, relativePath);

    const meta = [
      `- **id**: ${entry.id}`,
      `- **topic**: ${entry.topic}`,
      `- **confidence**: ${entry.confidence}`,
      `- **trust**: ${entry.trust}`,
      `- **created**: ${entry.created}`,
      `- **lastAccessed**: ${entry.lastAccessed}`,
    ];
    if (entry.sources.length > 0) {
      meta.push(`- **source**: ${entry.sources.join(', ')}`);
    }
    if (entry.references && entry.references.length > 0) {
      meta.push(`- **references**: ${entry.references.join(', ')}`);
    }
    if (entry.gitSha) {
      meta.push(`- **gitSha**: ${entry.gitSha}`);
    }
    if (entry.branch) {
      meta.push(`- **branch**: ${entry.branch}`);
    }

    const content = `# ${entry.title}\n${meta.join('\n')}\n\n${entry.content}\n`;

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  /** Delete the file for an entry */
  private async deleteEntryFile(entry: MemoryEntry): Promise<void> {
    const relativePath = this.entryToRelativePath(entry);
    const fullPath = path.join(this.memoryPath, relativePath);
    try { await fs.unlink(fullPath); } catch { /* already gone */ }

    // Clean up empty parent directories
    try {
      const dir = path.dirname(fullPath);
      const remaining = await fs.readdir(dir);
      if (remaining.length === 0 && dir !== this.memoryPath) {
        await fs.rmdir(dir);
      }
    } catch { /* ignore */ }
  }

  /** Load all entries from disk and return as an immutable snapshot.
   *  Pure read — no mutation. Callers decide whether to cache.
   *  Tracks corrupt files for observability without failing the load. */
  private async loadSnapshot(): Promise<{ readonly entries: ReadonlyMap<string, MemoryEntry>; readonly corruptFileCount: number }> {
    const entries = new Map<string, MemoryEntry>();
    let corruptFileCount = 0;

    try {
      const files = await this.findMarkdownFiles(this.memoryPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        const entry = this.parseSingleEntry(content);
        if (entry) {
          entries.set(entry.id, entry);
        } else {
          corruptFileCount++;
        }
      }
    } catch {
      // Empty memory — first run
    }

    return { entries, corruptFileCount };
  }

  /** Reload entries from disk into the store's working state.
   *  This is the single mutation point for disk reads. */
  private async reloadFromDisk(): Promise<void> {
    const snapshot = await this.loadSnapshot();
    this.entries = new Map(snapshot.entries);
    this.corruptFileCount = snapshot.corruptFileCount;
  }

  /** Recursively find all .md files in a directory */
  private async findMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...await this.findMarkdownFiles(fullPath));
        } else if (entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    } catch { /* ignore */ }
    return results;
  }

  /** Parse a single-entry Markdown file (# heading format).
   *  Validates topic and trust at the boundary — rejects corrupt files. */
  private parseSingleEntry(content: string): MemoryEntry | null {
    const titleMatch = content.match(/^# (.+)$/m);
    if (!titleMatch) return null;

    const title = titleMatch[1].trim();
    const metadata: Record<string, string> = {};

    const metaRegex = /^- \*\*(\w+)\*\*:\s*(.+)$/gm;
    let match;
    while ((match = metaRegex.exec(content)) !== null) {
      metadata[match[1]] = match[2].trim();
    }

    // Content is everything after the metadata block
    const lines = content.split('\n');
    let contentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^- \*\*\w+\*\*:/)) {
        contentStart = i + 1;
      }
    }
    while (contentStart < lines.length && lines[contentStart].trim() === '') {
      contentStart++;
    }
    const entryContent = lines.slice(contentStart).join('\n').trim();

    if (!metadata['id'] || !metadata['topic'] || entryContent.length === 0) return null;

    // Validate at boundary — reject entries with invalid topic or trust
    const topic = parseTopicScope(metadata['topic']);
    if (!topic) return null;

    const trust = parseTrustLevel(metadata['trust'] ?? 'agent-inferred');
    if (!trust) return null;

    const now = this.clock.isoNow();

    // Clamp confidence to valid 0.0-1.0 range at boundary
    const rawConfidence = parseFloat(metadata['confidence'] ?? '0.7');
    const confidence = Math.max(0.0, Math.min(1.0, isNaN(rawConfidence) ? 0.7 : rawConfidence));

    const references = metadata['references']
      ? metadata['references'].split(',').map(s => s.trim()).filter(s => s.length > 0)
      : undefined;

    return {
      id: metadata['id'],
      topic,
      title,
      content: entryContent,
      confidence,
      trust,
      sources: metadata['source'] ? metadata['source'].split(',').map(s => s.trim()) : [],
      references: references && references.length > 0 ? references : undefined,
      created: metadata['created'] ?? now,
      lastAccessed: metadata['lastAccessed'] ?? now,
      gitSha: metadata['gitSha'],
      branch: metadata['branch'],
    };
  }

  private formatEntry(entry: MemoryEntry, detail: DetailLevel): QueryEntry {
    const base: QueryEntry = {
      id: entry.id,
      title: entry.title,
      summary: detail === 'brief'
        ? this.summarize(entry.content, 100)
        : detail === 'standard'
        ? this.summarize(entry.content, 300)
        : entry.content,
      confidence: entry.confidence,
      relevanceScore: entry.confidence, // default; overridden in query() when filter is present
      fresh: this.isFresh(entry),
    };

    if (detail === 'standard') {
      return {
        ...base,
        // Surface references in standard detail — compact but useful for navigation
        references: entry.references,
      };
    }

    if (detail === 'full') {
      return {
        ...base,
        content: entry.content,
        trust: entry.trust,
        sources: entry.sources,
        references: entry.references,
        created: entry.created,
        lastAccessed: entry.lastAccessed,
        gitSha: entry.gitSha,
        branch: entry.branch,
      };
    }

    return base;
  }

  private isFresh(entry: MemoryEntry): boolean {
    // User identity never goes stale — name, role, employer change on a scale of years
    if (entry.topic === 'user') return true;

    const daysSinceAccess = this.daysSinceAccess(entry);
    const { staleDaysStandard, staleDaysPreferences } = this.behavior;

    // Preferences evolve slowly — longer threshold to avoid noisy renewal nudges
    if (entry.topic === 'preferences') return daysSinceAccess <= staleDaysPreferences;

    // Everything else (including gotchas) uses the standard threshold.
    // Gotchas are deliberately NOT exempt: code changes make them the most dangerous when stale.
    // Trust level does NOT grant freshness exemption — trust reflects source quality at write time,
    // not temporal validity. A user-confirmed entry from 6 months ago can still be outdated.
    return daysSinceAccess <= staleDaysStandard;
  }

  /** Days elapsed since entry was last accessed */
  private daysSinceAccess(entry: MemoryEntry): number {
    const now = this.clock.now().getTime();
    const lastAccessed = new Date(entry.lastAccessed).getTime();
    return (now - lastAccessed) / (1000 * 60 * 60 * 24);
  }

  private summarize(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const truncated = text.substring(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > maxChars * 0.5 ? truncated.substring(0, lastSpace) : truncated) + '...';
  }

  /** Get HEAD SHA for source tracking — delegates to injected GitService */
  private async getGitSha(sources: string[]): Promise<string | undefined> {
    if (sources.length === 0) return undefined;
    return this.git.getHeadSha(this.config.repoRoot);
  }

  /** Get total storage size in bytes, or null if unmeasurable */
  private async getStorageSize(): Promise<number | null> {
    let totalSize = 0;
    try {
      const files = await this.findMarkdownFiles(this.memoryPath);
      for (const file of files) {
        const stat = await fs.stat(file);
        totalSize += stat.size;
      }
      return totalSize;
    } catch {
      return null;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  }

  // --- Dedup and preference surfacing ---

  /** Find entries in the same topic with significant overlap (dedup detection).
   *  Uses hybrid jaccard+containment similarity. */
  private findRelatedEntries(newEntry: MemoryEntry, excludeId?: string): RelatedEntry[] {
    const related: Array<{ entry: MemoryEntry; similarity: number }> = [];

    for (const entry of this.entries.values()) {
      if (entry.id === newEntry.id) continue;
      if (excludeId && entry.id === excludeId) continue;
      if (entry.topic !== newEntry.topic) continue;

      const sim = similarity(
        newEntry.title, newEntry.content,
        entry.title, entry.content,
      );

      if (sim > DEDUP_SIMILARITY_THRESHOLD) {
        related.push({ entry, similarity: sim });
      }
    }

    return related
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.behavior.maxDedupSuggestions)
      .map(r => ({
        id: r.entry.id,
        title: r.entry.title,
        content: r.entry.content,
        confidence: r.entry.confidence,
        trust: r.entry.trust,
      }));
  }

  /** Fetch raw MemoryEntry objects by ID for conflict detection.
   *  Must be called after query() (which calls reloadFromDisk) to ensure entries are current. */
  getEntriesByIds(ids: readonly string[]): MemoryEntry[] {
    return ids.flatMap(id => {
      const entry = this.entries.get(id);
      return entry ? [entry] : [];
    });
  }

  /** Detect potential conflicts in a result set — lazy, high-signal, never background.
   *  Compares all pairs from the given entries using similarity().
   *  Only flags pairs where both entries have substantive content (>50 chars) and
   *  similarity exceeds 0.6. Returns at most 2 pairs to avoid overwhelming the agent.
   *
   *  Accepts a minimal shape so it works with both MemoryEntry and QueryEntry (full detail). */
  detectConflicts(entries: readonly Pick<MemoryEntry, 'id' | 'title' | 'content' | 'confidence' | 'created' | 'topic' | 'trust'>[]): ConflictPair[] {
    type Scored = { pair: ConflictPair; score: number };
    const conflicts: Scored[] = [];

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];

        // Skip entries with trivially short content — similarity on short text is noisy
        if (a.content.length <= CONFLICT_MIN_CONTENT_CHARS || b.content.length <= CONFLICT_MIN_CONTENT_CHARS) continue;

        const contentSim = similarity(a.title, a.content, b.title, b.content);
        const titleSim = similarity(a.title, '', b.title, '');

        // Tiered thresholds: cross-topic gets lower bar (more suspicious when different topics overlap)
        const isSameTopic = a.topic === b.topic;
        let threshold = isSameTopic ? CONFLICT_SIMILARITY_THRESHOLD_SAME_TOPIC : CONFLICT_SIMILARITY_THRESHOLD_CROSS_TOPIC;

        // Title similarity: if titles overlap significantly, they're about the same thing
        // Lower content threshold since even moderate overlap becomes suspicious
        if (titleSim > 0.30) {
          threshold = Math.min(threshold, 0.38);
        }

        // Trust level boost: two user-corrected entries contradicting is highest-signal
        const bothUserTrust = a.trust === 'user' && b.trust === 'user';
        const trustBoost = bothUserTrust ? 1.3 : 1.0;

        // Opposition word detection: negation indicators suggest prescriptive contradiction
        const NEGATION_INDICATORS = /\b(not|never|avoid|instead of|rather than|deprecated|obsolete|don'?t use)\b/gi;
        const aNegations = (a.content.match(NEGATION_INDICATORS) || []).length;
        const bNegations = (b.content.match(NEGATION_INDICATORS) || []).length;
        const hasNegations = aNegations > 0 && bNegations > 0;

        // Check for explicit opposition pairs in content
        const aLower = a.content.toLowerCase();
        const bLower = b.content.toLowerCase();
        const oppositionMatch = OPPOSITION_PAIRS.some(([term1, term2]) =>
          (aLower.includes(term1) && bLower.includes(term2)) ||
          (aLower.includes(term2) && bLower.includes(term1))
        );

        // Opposition boost: entries using opposing keywords get stronger conflict signal
        const oppositionBoost = (hasNegations || oppositionMatch) ? 1.25 : 1.0;

        const adjustedScore = contentSim * trustBoost * oppositionBoost;

        if (adjustedScore > threshold) {
          conflicts.push({
            pair: {
              a: { id: a.id, title: a.title, confidence: a.confidence, created: a.created },
              b: { id: b.id, title: b.title, confidence: b.confidence, created: b.created },
              similarity: contentSim, // store raw similarity for display transparency
            },
            score: adjustedScore, // sort by adjusted score
          });
        }
      }
    }

    // Surface highest-similarity conflicts first, cap per behavior config
    return conflicts
      .sort((x, y) => y.score - x.score)
      .slice(0, this.behavior.maxConflictPairs)
      .map(c => c.pair);
  }

  /** Find preferences relevant to a given entry (cross-topic overlap).
   *  Lower threshold than dedup since preferences are always worth surfacing. */
  private findRelevantPreferences(entry: MemoryEntry): RelatedEntry[] {
    const relevant: Array<{ entry: MemoryEntry; similarity: number }> = [];

    for (const pref of this.entries.values()) {
      if (pref.topic !== 'preferences') continue;

      const sim = similarity(
        entry.title, entry.content,
        pref.title, pref.content,
      );

      if (sim > PREFERENCE_SURFACE_THRESHOLD) {
        relevant.push({ entry: pref, similarity: sim });
      }
    }

    return relevant
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, DEFAULT_MAX_PREFERENCE_SUGGESTIONS)
      .map(r => ({
        id: r.entry.id,
        title: r.entry.title,
        content: r.entry.content,
        confidence: r.entry.confidence,
        trust: r.entry.trust,
      }));
  }
}
