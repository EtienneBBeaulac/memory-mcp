import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { MarkdownMemoryStore } from '../store.js';
import type { MemoryConfig } from '../types.js';
import { DEFAULT_STORAGE_BUDGET_BYTES } from '../types.js';
import {
  stem, extractKeywords, jaccardSimilarity, containmentSimilarity,
  similarity, parseFilter, matchesFilter, computeRelevanceScore,
} from '../text-analyzer.js';

// Helper to create a temp directory for each test
async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-test-'));
}

async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function makeConfig(repoRoot: string): MemoryConfig {
  return { repoRoot, memoryPath: path.join(repoRoot, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES };
}

describe('MarkdownMemoryStore', () => {
  let tempDir: string;
  let store: MarkdownMemoryStore;

  beforeEach(async () => {
    tempDir = await createTempDir();
    store = new MarkdownMemoryStore(makeConfig(tempDir));
    await store.init();
  });

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir).catch(() => {});
  });

  describe('init', () => {
    it('creates memory directory', async () => {
      const memDir = path.join(tempDir, '.memory');
      const stat = await fs.stat(memDir);
      assert.ok(stat.isDirectory());
    });

    it('succeeds on empty directory', async () => {
      const stats = await store.stats();
      assert.strictEqual(stats.totalEntries, 0);
    });
  });

  describe('store', () => {
    it('stores a basic entry', async () => {
      const result = await store.store('architecture', 'Test Entry', 'This is test content');
      assert.ok(result.stored);
      if (!result.stored) return; // narrow for TS
      assert.ok(result.id.startsWith('arch-'));
      assert.strictEqual(result.topic, 'architecture');
      assert.strictEqual(result.confidence, 0.70); // agent-inferred default
    });

    it('stores with explicit trust level', async () => {
      const result = await store.store('conventions', 'Code Style', 'Use tabs', [], 'user');
      assert.ok(result.stored);
      if (!result.stored) return;
      assert.strictEqual(result.confidence, 1.0);
    });

    it('persists to individual Markdown file', async () => {
      const result = await store.store('architecture', 'Arch Entry', 'Architecture content here');
      assert.ok(result.stored);
      if (!result.stored) return;
      const filePath = path.join(tempDir, '.memory', 'architecture', `${result.id}.md`);
      const content = await fs.readFile(filePath, 'utf-8');
      assert.ok(content.includes('# Arch Entry'));
      assert.ok(content.includes('Architecture content here'));
      assert.ok(content.includes('- **topic**: architecture'));
    });

    it('generates random hex IDs (no collisions)', async () => {
      const r1 = await store.store('architecture', 'Entry 1', 'Content 1');
      const r2 = await store.store('architecture', 'Entry 2', 'Content 2');
      assert.ok(r1.stored && r2.stored);
      if (!r1.stored || !r2.stored) return;
      assert.notStrictEqual(r1.id, r2.id);
      assert.match(r1.id, /^arch-[0-9a-f]{8}$/);
      assert.match(r2.id, /^arch-[0-9a-f]{8}$/);
    });

    it('overwrites entry with same title in same topic', async () => {
      await store.store('conventions', 'Naming', 'Use camelCase');
      const r2 = await store.store('conventions', 'Naming', 'Use snake_case');
      assert.ok(r2.stored);
      if (!r2.stored) return;
      assert.ok(r2.warning?.includes('Overwrote'));

      const query = await store.query('conventions', 'full');
      assert.strictEqual(query.totalEntries, 1);
      assert.ok(query.entries[0].content?.includes('snake_case'));
    });

    it('uses correct ID prefix per topic', async () => {
      const arch = await store.store('architecture', 'A', 'a');
      const conv = await store.store('conventions', 'B', 'b');
      const gotcha = await store.store('gotchas', 'C', 'c');
      const recent = await store.store('recent-work', 'D', 'd');

      assert.ok(arch.stored && conv.stored && gotcha.stored && recent.stored);
      if (!arch.stored || !conv.stored || !gotcha.stored || !recent.stored) return;
      assert.ok(arch.id.startsWith('arch-'));
      assert.ok(conv.id.startsWith('conv-'));
      assert.ok(gotcha.id.startsWith('gotcha-'));
      assert.ok(recent.id.startsWith('recent-'));
    });

    it('stores module-scoped entries in subdirectory', async () => {
      const result = await store.store('modules/messaging', 'Messaging Module', 'Handles chat');
      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(result.id.startsWith('mod-'));

      // Verify file exists in modules/messaging/ subdirectory
      const filePath = path.join(tempDir, '.memory', 'modules', 'messaging', `${result.id}.md`);
      const stat = await fs.stat(filePath);
      assert.ok(stat.isFile());
    });
  });

  describe('one file per entry', () => {
    it('creates separate files for each entry', async () => {
      const r1 = await store.store('architecture', 'Entry 1', 'Content 1');
      const r2 = await store.store('architecture', 'Entry 2', 'Content 2');
      assert.ok(r1.stored && r2.stored);
      if (!r1.stored || !r2.stored) return;

      const archDir = path.join(tempDir, '.memory', 'architecture');
      const files = await fs.readdir(archDir);
      assert.strictEqual(files.length, 2);
      assert.ok(files.includes(`${r1.id}.md`));
      assert.ok(files.includes(`${r2.id}.md`));
    });

    it('each file contains exactly one entry', async () => {
      const r1 = await store.store('gotchas', 'Gotcha 1', 'Watch out for this');
      assert.ok(r1.stored);
      if (!r1.stored) return;
      const filePath = path.join(tempDir, '.memory', 'gotchas', `${r1.id}.md`);
      const content = await fs.readFile(filePath, 'utf-8');

      // Should have exactly one # heading
      const headings = content.match(/^# /gm);
      assert.strictEqual(headings?.length, 1);
    });

    it('deleting an entry removes the file', async () => {
      const r1 = await store.store('conventions', 'To Delete', 'Temporary');
      assert.ok(r1.stored);
      if (!r1.stored) return;
      const filePath = path.join(tempDir, '.memory', 'conventions', `${r1.id}.md`);

      // File exists
      const stat = await fs.stat(filePath);
      assert.ok(stat.isFile());

      // Delete via correct
      await store.correct(r1.id, '', 'delete');

      // File is gone
      await assert.rejects(fs.stat(filePath));
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      await store.store('architecture', 'Arch Pattern', 'Uses MVI architecture', [], 'user');
      await store.store('conventions', 'Naming', 'Use camelCase for functions', [], 'agent-confirmed');
      await store.store('gotchas', 'Build Gotcha', 'Must run pod install first', [], 'user');
    });

    it('queries all entries with wildcard scope', async () => {
      const result = await store.query('*', 'brief');
      assert.strictEqual(result.totalEntries, 3);
    });

    it('queries specific topic', async () => {
      const result = await store.query('architecture', 'brief');
      assert.strictEqual(result.totalEntries, 1);
      assert.strictEqual(result.entries[0].title, 'Arch Pattern');
    });

    it('respects detail levels', async () => {
      const brief = await store.query('architecture', 'brief');
      const full = await store.query('architecture', 'full');

      assert.ok(!brief.entries[0].content);
      assert.ok(full.entries[0].content);
      assert.ok(full.entries[0].trust);
      assert.ok(full.entries[0].sources);
    });

    it('filters by keyword', async () => {
      const result = await store.query('*', 'brief', 'MVI');
      assert.strictEqual(result.totalEntries, 1);
      assert.strictEqual(result.entries[0].title, 'Arch Pattern');
    });

    it('returns empty for non-matching filter', async () => {
      const result = await store.query('*', 'brief', 'nonexistent-keyword-xyz');
      assert.strictEqual(result.totalEntries, 0);
    });

    it('sorts by confidence descending', async () => {
      const result = await store.query('*', 'brief');
      assert.ok(result.entries[0].confidence >= result.entries[1].confidence);
    });
  });

  describe('correct', () => {
    it('appends to existing entry', async () => {
      const stored = await store.store('conventions', 'Style', 'Use tabs');
      assert.ok(stored.stored);
      if (!stored.stored) return;
      const corrected = await store.correct(stored.id, 'Also use 2-space indentation for YAML', 'append');

      assert.ok(corrected.corrected);
      if (!corrected.corrected) return;
      assert.strictEqual(corrected.newConfidence, 1.0);
      assert.strictEqual(corrected.trust, 'user');

      const query = await store.query('conventions', 'full');
      assert.ok(query.entries[0].content?.includes('tabs'));
      assert.ok(query.entries[0].content?.includes('YAML'));
    });

    it('replaces existing entry content', async () => {
      const stored = await store.store('conventions', 'Style', 'Use tabs');
      assert.ok(stored.stored);
      if (!stored.stored) return;
      const corrected = await store.correct(stored.id, 'Use spaces', 'replace');

      assert.ok(corrected.corrected);
      const query = await store.query('conventions', 'full');
      assert.ok(!query.entries[0].content?.includes('tabs'));
      assert.ok(query.entries[0].content?.includes('spaces'));
    });

    it('deletes an entry', async () => {
      const stored = await store.store('conventions', 'Style', 'Use tabs');
      assert.ok(stored.stored);
      if (!stored.stored) return;
      const corrected = await store.correct(stored.id, '', 'delete');

      assert.ok(corrected.corrected);
      const query = await store.query('conventions', 'brief');
      assert.strictEqual(query.totalEntries, 0);
    });

    it('returns error for non-existent entry', async () => {
      const result = await store.correct('nonexistent-999', 'fix', 'replace');
      assert.ok(!result.corrected);
      if (result.corrected) return;
      assert.ok(result.error?.includes('not found'));
    });
  });

  describe('briefing', () => {
    it('returns bootstrap suggestion when empty', async () => {
      const result = await store.briefing();
      assert.ok(result.briefing.includes('No knowledge stored'));
      assert.ok(result.suggestion?.includes('bootstrap'));
    });

    it('generates briefing with entries', async () => {
      await store.store('architecture', 'Pattern', 'Uses MVVM', [], 'user');
      await store.store('gotchas', 'Build Issue', 'Must clean build folder', [], 'user');

      const result = await store.briefing();
      assert.ok(result.briefing.includes('Build Issue'));
      assert.strictEqual(result.entryCount, 2);
    });

    it('prioritizes gotchas in briefing', async () => {
      await store.store('architecture', 'Pattern', 'Uses MVVM', [], 'user');
      await store.store('gotchas', 'Critical Bug', 'Avoid using force unwrap', [], 'user');

      const result = await store.briefing();
      const gotchaPos = result.briefing.indexOf('Gotchas');
      const archPos = result.briefing.indexOf('Architecture');
      if (gotchaPos >= 0 && archPos >= 0) {
        assert.ok(gotchaPos < archPos, 'Gotchas should appear before Architecture');
      }
    });
  });

  describe('stats', () => {
    it('returns zero stats for empty store', async () => {
      const stats = await store.stats();
      assert.strictEqual(stats.totalEntries, 0);
      assert.strictEqual(stats.corruptFiles, 0);
      assert.deepStrictEqual(stats.byTrust, { 'user': 0, 'agent-confirmed': 0, 'agent-inferred': 0 });
    });

    it('returns correct counts', async () => {
      await store.store('architecture', 'A', 'a', [], 'user');
      await store.store('conventions', 'B', 'b', [], 'agent-confirmed');
      await store.store('gotchas', 'C', 'c', [], 'agent-inferred');

      const stats = await store.stats();
      assert.strictEqual(stats.totalEntries, 3);
      assert.strictEqual(stats.byTrust['user'], 1);
      assert.strictEqual(stats.byTrust['agent-confirmed'], 1);
      assert.strictEqual(stats.byTrust['agent-inferred'], 1);
      assert.strictEqual(stats.byTopic['architecture'], 1);
    });

    it('reports memory path', async () => {
      const stats = await store.stats();
      assert.strictEqual(stats.memoryPath, path.join(tempDir, '.memory'));
    });
  });

  describe('persistence and reload', () => {
    it('survives restart (reload from disk)', async () => {
      await store.store('architecture', 'Persistence Test', 'This should survive', [], 'user');
      await store.store('gotchas', 'Gotcha Test', 'This too', [], 'agent-confirmed');

      const store2 = new MarkdownMemoryStore(makeConfig(tempDir));
      await store2.init();

      const query = await store2.query('*', 'full');
      assert.strictEqual(query.totalEntries, 2);

      const archEntry = query.entries.find(e => e.title === 'Persistence Test');
      assert.ok(archEntry);
      assert.ok(archEntry.content?.includes('should survive'));
      assert.strictEqual(archEntry.trust, 'user');
    });

    it('handles corrected entries across restart', async () => {
      const stored = await store.store('conventions', 'Style', 'Use tabs', [], 'agent-inferred');
      assert.ok(stored.stored);
      if (!stored.stored) return;
      await store.correct(stored.id, 'Use spaces', 'replace');

      const store2 = new MarkdownMemoryStore(makeConfig(tempDir));
      await store2.init();

      const query = await store2.query('conventions', 'full');
      assert.strictEqual(query.totalEntries, 1);
      assert.ok(query.entries[0].content?.includes('spaces'));
      assert.strictEqual(query.entries[0].trust, 'user');
    });
  });

  describe('cross-process safety', () => {
    it('two stores see each other\'s writes after reload', async () => {
      const sharedConfig = makeConfig(tempDir);
      const storeA = new MarkdownMemoryStore(sharedConfig);
      const storeB = new MarkdownMemoryStore(sharedConfig);
      await storeA.init();
      await storeB.init();

      await storeA.store('gotchas', 'Process A Gotcha', 'Found by process A', [], 'user');

      const result = await storeB.query('gotchas', 'full');
      assert.strictEqual(result.totalEntries, 1);
      assert.strictEqual(result.entries[0].title, 'Process A Gotcha');
    });

    it('two stores writing different entries don\'t clobber', async () => {
      const sharedConfig = makeConfig(tempDir);
      const storeA = new MarkdownMemoryStore(sharedConfig);
      const storeB = new MarkdownMemoryStore(sharedConfig);
      await storeA.init();
      await storeB.init();

      await storeA.store('architecture', 'Pattern A', 'Content A');
      await storeB.store('architecture', 'Pattern B', 'Content B');

      const storeC = new MarkdownMemoryStore(sharedConfig);
      await storeC.init();
      const result = await storeC.query('architecture', 'brief');
      assert.strictEqual(result.totalEntries, 2);

      const titles = result.entries.map(e => e.title).sort();
      assert.deepStrictEqual(titles, ['Pattern A', 'Pattern B']);
    });
  });

  describe('branch tagging', () => {
    it('recent-work entries include branch field', async () => {
      await store.store('recent-work', 'Session Context', 'Working on messaging');
      const query = await store.query('recent-work', 'full', undefined, '*');

      assert.strictEqual(query.totalEntries, 1);
      assert.ok(query.entries[0].branch !== undefined);
    });

    it('non-recent-work entries do not have branch', async () => {
      await store.store('architecture', 'Pattern', 'Uses MVI');
      const query = await store.query('architecture', 'full');

      assert.strictEqual(query.entries[0].branch, undefined);
    });

    it('recent-work stored in branch-scoped subdirectory', async () => {
      const result = await store.store('recent-work', 'Session', 'Context');
      assert.ok(result.stored);

      const recentDir = path.join(tempDir, '.memory', 'recent-work');
      const branchDirs = await fs.readdir(recentDir);
      assert.strictEqual(branchDirs.length, 1);

      const branchDir = path.join(recentDir, branchDirs[0]);
      const files = await fs.readdir(branchDir);
      assert.strictEqual(files.length, 1);
      assert.ok(files[0].endsWith('.md'));
    });
  });

  describe('bootstrap', () => {
    it('seeds entries from repo structure', async () => {
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'tests'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'package.json'), '{}');
      await fs.writeFile(path.join(tempDir, 'README.md'), '# Test Project\n\nA test project for unit tests.');

      const results = await store.bootstrap();
      const stored = results.filter(r => r.stored);

      assert.ok(stored.length >= 2, `Expected at least 2 entries, got ${stored.length}`);
      const topics = stored.map(r => r.topic);
      assert.ok(topics.includes('architecture'), 'Should have architecture entries');
    });
  });

  describe('storage budget', () => {
    it('rejects writes when budget exceeded', async () => {
      const tinyConfig: MemoryConfig = {
        repoRoot: tempDir,
        memoryPath: path.join(tempDir, '.memory'),
        storageBudgetBytes: 100,
      };
      const tinyStore = new MarkdownMemoryStore(tinyConfig);
      await tinyStore.init();

      const r1 = await tinyStore.store('architecture', 'Entry 1', 'Some content that is long enough to exceed our budget');
      assert.ok(r1.stored);

      const r2 = await tinyStore.store('conventions', 'Entry 2', 'More content');
      assert.ok(!r2.stored);
      assert.ok(r2.warning?.includes('budget'));
    });
  });

  describe('sanitizeBranchName', () => {
    it('handles branch names with slashes', async () => {
      const result = await store.store('recent-work', 'Test', 'Content');
      assert.ok(result.stored);
    });
  });

  describe('user and preferences topics', () => {
    it('stores user entries with correct ID prefix', async () => {
      const result = await store.store('user', 'Name and Role', 'Etienne, Senior Android Engineer', [], 'user');
      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(result.id.startsWith('user-'), `ID should start with user-, got ${result.id}`);
      assert.strictEqual(result.topic, 'user');
      assert.strictEqual(result.confidence, 1.0);
    });

    it('stores preferences with correct ID prefix', async () => {
      const result = await store.store('preferences', 'Naming Convention', 'Use Real prefix instead of Impl postfix', [], 'user');
      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(result.id.startsWith('pref-'), `ID should start with pref-, got ${result.id}`);
    });

    it('user and preferences are always fresh', async () => {
      await store.store('user', 'Role', 'Engineer');
      await store.store('preferences', 'Style', 'Prefer sealed interfaces');
      
      const result = await store.query('*', 'full');
      const userEntries = result.entries.filter(e => e.content?.includes('Engineer'));
      const prefEntries = result.entries.filter(e => e.content?.includes('sealed'));
      
      assert.ok(userEntries.length > 0);
      assert.ok(prefEntries.length > 0);
      assert.strictEqual(userEntries[0].fresh, true);
      assert.strictEqual(prefEntries[0].fresh, true);
    });

    it('briefing shows user before preferences before gotchas', async () => {
      await store.store('gotchas', 'Build Gotcha', 'Must clean build after changes', [], 'user');
      await store.store('user', 'Identity', 'Etienne, Android Engineer', [], 'user');
      await store.store('preferences', 'No Emojis', 'Never use emojis in commit messages', [], 'user');
      await store.store('architecture', 'Pattern', 'MVI architecture', [], 'agent-confirmed');

      const briefing = await store.briefing(2000);
      const text = briefing.briefing;

      const userIdx = text.indexOf('About You');
      const prefIdx = text.indexOf('Your Preferences');
      const gotchaIdx = text.indexOf('Active Gotchas');
      const archIdx = text.indexOf('Architecture');

      assert.ok(userIdx >= 0, 'Should have About You section');
      assert.ok(prefIdx >= 0, 'Should have Your Preferences section');
      assert.ok(gotchaIdx >= 0, 'Should have Active Gotchas section');
      assert.ok(archIdx >= 0, 'Should have Architecture section');

      assert.ok(userIdx < prefIdx, `About You (${userIdx}) should come before Your Preferences (${prefIdx})`);
      assert.ok(prefIdx < gotchaIdx, `Your Preferences (${prefIdx}) should come before Active Gotchas (${gotchaIdx})`);
      assert.ok(gotchaIdx < archIdx, `Active Gotchas (${gotchaIdx}) should come before Architecture (${archIdx})`);
    });
  });

  // --- Text analyzer tests ---

  describe('stemming', () => {
    it('strips common suffixes', () => {
      assert.strictEqual(stem('reducers'), 'reducer');
      assert.strictEqual(stem('implementations'), 'implement');
      assert.strictEqual(stem('handling'), 'handl');
      assert.strictEqual(stem('sealed'), 'seal');
      assert.strictEqual(stem('patterns'), 'pattern');
      assert.strictEqual(stem('classes'), 'class');
    });

    it('leaves short words alone', () => {
      assert.strictEqual(stem('mvi'), 'mvi');
      assert.strictEqual(stem('api'), 'api');
    });

    it('leaves already-stemmed words alone', () => {
      assert.strictEqual(stem('kotlin'), 'kotlin');
      assert.strictEqual(stem('swift'), 'swift');
    });
  });

  describe('keyword extraction and similarity', () => {
    it('extracts meaningful keywords with stemming', () => {
      const keywords = extractKeywords('Use Real prefix instead of Impl postfix for implementations');
      assert.ok(keywords.has('real'));
      assert.ok(keywords.has('prefix'));
      assert.ok(keywords.has('impl'));
      assert.ok(keywords.has('postfix'));
      assert.ok(keywords.has('implement')); // stemmed from "implementations"
      assert.ok(!keywords.has('of'));
      assert.ok(!keywords.has('for'));
      assert.ok(!keywords.has('use'));
    });

    it('stems plurals so reducer matches reducers', () => {
      const kwA = extractKeywords('standalone reducer');
      const kwB = extractKeywords('standalone reducers');
      assert.ok(kwA.has('reducer'));
      assert.ok(kwB.has('reducer'));
    });

    it('handles code-like content', () => {
      const keywords = extractKeywords('MutableStateFlow causes race conditions in ViewModel');
      assert.ok(keywords.has('mutablestateflow'));
      assert.ok(keywords.has('race'));
      assert.ok(keywords.has('viewmodel'));
    });

    it('computes Jaccard similarity correctly', () => {
      const a = new Set(['mvi', 'pattern', 'architecture', 'reducer']);
      const b = new Set(['mvi', 'architecture', 'standalone', 'reducer']);
      const sim = jaccardSimilarity(a, b);
      assert.strictEqual(sim, 0.6);
    });

    it('computes containment similarity correctly', () => {
      const small = new Set(['mvi', 'pattern']);
      const large = new Set(['mvi', 'pattern', 'standalone', 'reducer', 'viewmodel']);
      const sim = containmentSimilarity(small, large);
      assert.strictEqual(sim, 1.0);
    });

    it('containment catches subset relationships that Jaccard misses', () => {
      const small = new Set(['mvi', 'pattern']);
      const large = new Set(['mvi', 'pattern', 'standalone', 'reducer', 'viewmodel']);
      const jaccard = jaccardSimilarity(small, large);
      const containment = containmentSimilarity(small, large);
      assert.ok(jaccard <= 0.4, `Jaccard ${jaccard} should be low`);
      assert.ok(containment === 1.0, `Containment ${containment} should be 1.0`);
    });

    it('hybrid similarity uses max of jaccard and containment', () => {
      const sim = similarity(
        'MVI Pattern', 'Use MVI pattern',
        'Architecture Overview', 'MVI pattern with standalone reducers ViewModels and sealed interfaces',
      );
      assert.ok(sim > 0.5, `Hybrid similarity ${sim} should be > 0.5`);
    });

    it('returns 0 for disjoint sets', () => {
      assert.strictEqual(jaccardSimilarity(new Set(['kotlin', 'android']), new Set(['swift', 'ios'])), 0);
      assert.strictEqual(containmentSimilarity(new Set(['kotlin', 'android']), new Set(['swift', 'ios'])), 0);
    });

    it('returns 0 for empty sets', () => {
      assert.strictEqual(jaccardSimilarity(new Set(), new Set()), 0);
      assert.strictEqual(containmentSimilarity(new Set(), new Set()), 0);
    });
  });

  describe('dedup detection', () => {
    it('surfaces related entries when storing similar content', async () => {
      await store.store('architecture', 'MVI Pattern', 'This repo uses MVI architecture with standalone reducers and ViewModels');
      const result = await store.store('architecture', 'Architecture Overview', 'MVI architecture pattern with standalone reducers for state management');

      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(result.relatedEntries, 'Should have relatedEntries');
      assert.ok(result.relatedEntries!.length > 0, 'Should have at least one related entry');
      assert.strictEqual(result.relatedEntries![0].title, 'MVI Pattern');
    });

    it('does not flag unrelated entries', async () => {
      await store.store('architecture', 'Build System', 'Uses Gradle with Kotlin DSL for dependency management');
      const result = await store.store('architecture', 'Networking', 'Retrofit with OkHttp for REST API calls and coroutines');

      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(!result.relatedEntries || result.relatedEntries.length === 0);
    });

    it('only flags entries in the same topic', async () => {
      await store.store('conventions', 'Naming', 'Use Real prefix instead of Impl postfix');
      const result = await store.store('architecture', 'Naming Patterns', 'Use Real prefix for implementation classes in architecture');

      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(!result.relatedEntries || result.relatedEntries.length === 0);
    });
  });

  describe('preference surfacing', () => {
    it('surfaces relevant preferences when storing conventions', async () => {
      await store.store('preferences', 'Kotlin Naming', 'Use Real prefix instead of Impl postfix for Kotlin implementation classes', [], 'user');
      const result = await store.store('conventions', 'Implementation Naming', 'Kotlin implementation classes should use naming prefix convention Real instead of Impl');

      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(result.relevantPreferences, 'Should have relevantPreferences');
      assert.ok(result.relevantPreferences!.length > 0);
      assert.ok(result.relevantPreferences![0].title.includes('Naming'));
    });

    it('does not surface preferences for preference entries', async () => {
      await store.store('preferences', 'Style A', 'Prefer composition over inheritance');
      const result = await store.store('preferences', 'Style B', 'Use composition patterns in architecture');
      
      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(!result.relevantPreferences || result.relevantPreferences.length === 0);
    });
  });

  describe('contextual search', () => {
    it('returns relevant entries for a context description', async () => {
      await store.store('architecture', 'MVI Pattern', 'Uses MVI architecture with standalone reducer classes in Kotlin');
      await store.store('conventions', 'Kotlin Style', 'Kotlin sealed interfaces for state management');
      await store.store('gotchas', 'Build Issue', 'Clean build required after Kotlin module changes');
      await store.store('conventions', 'Swift Patterns', 'Use protocol-oriented design in Swift');

      const results = await store.contextSearch('Kotlin reducer state management');

      assert.ok(results.length > 0, 'Should have results');
      
      const mviResult = results.find(r => r.entry.title === 'MVI Pattern');
      assert.ok(mviResult, 'Should include MVI Pattern entry');
      
      const kotlinResults = results.filter(r => 
        r.matchedKeywords.includes('kotlin')
      );
      assert.ok(kotlinResults.length > 0, 'Should match Kotlin-related entries');
    });

    it('always includes user entries even without keyword match', async () => {
      await store.store('user', 'Identity', 'Senior Android Engineer at Zillow', [], 'user');
      await store.store('architecture', 'Pattern', 'MVI with reducers');

      const results = await store.contextSearch('swift ui layout');

      const userResult = results.find(r => r.entry.topic === 'user');
      assert.ok(userResult, 'Should always include user entries');
    });

    it('boosts gotchas and preferences in scoring', async () => {
      await store.store('architecture', 'Kotlin Build', 'Kotlin module build configuration');
      await store.store('gotchas', 'Kotlin Gotcha', 'Kotlin module requires clean build after changes', [], 'user');
      await store.store('preferences', 'Kotlin Pref', 'Always use Kotlin sealed interfaces', [], 'user');

      const results = await store.contextSearch('kotlin module');

      assert.ok(results.length >= 3);
      const gotchaIdx = results.findIndex(r => r.entry.topic === 'gotchas');
      const archIdx = results.findIndex(r => r.entry.topic === 'architecture');
      
      assert.ok(gotchaIdx < archIdx, `Gotcha (idx ${gotchaIdx}) should rank before architecture (idx ${archIdx})`);
    });

    it('returns empty for no-match context', async () => {
      await store.store('architecture', 'MVI', 'Uses MVI pattern');
      
      const results = await store.contextSearch('quantum computing algorithms');
      assert.strictEqual(results.length, 0);
    });

    it('respects minMatch threshold', async () => {
      await store.store('architecture', 'MVI Architecture', 'Uses MVI pattern with standalone reducers and sealed interfaces for events');

      const strict = await store.contextSearch('kotlin coroutines flow testing reducer', 10, undefined, 0.4);
      assert.strictEqual(strict.length, 0, 'Should exclude low-match entries with high threshold');

      const lenient = await store.contextSearch('kotlin coroutines flow testing reducer', 10, undefined, 0.1);
      assert.ok(lenient.length > 0, 'Should include with low threshold');
    });
  });

  describe('smart filter syntax', () => {
    beforeEach(async () => {
      await store.store('architecture', 'MVI Architecture', 'Uses MVI pattern with standalone reducers and sealed interfaces for events');
      await store.store('conventions', 'Kotlin Naming', 'Use Real prefix instead of Impl postfix for implementation classes');
      await store.store('conventions', 'Error Handling', 'Always use Result type, never throw exceptions');
      await store.store('gotchas', 'Deprecated API', 'The old messaging API is deprecated, use StreamCoordinator instead');
    });

    it('space-separated terms use AND logic', async () => {
      const result = await store.query('*', 'brief', 'MVI reducer');
      assert.strictEqual(result.entries.length, 1);
      assert.ok(result.entries[0].title.includes('MVI'));
    });

    it('AND filter excludes partial matches', async () => {
      const result = await store.query('*', 'brief', 'MVI kotlin');
      assert.strictEqual(result.entries.length, 0);
    });

    it('pipe-separated terms use OR logic', async () => {
      const result = await store.query('*', 'brief', 'MVI|Result');
      assert.strictEqual(result.entries.length, 2);
    });

    it('minus prefix excludes entries', async () => {
      const result = await store.query('conventions', 'brief', 'Real -exception');
      assert.strictEqual(result.entries.length, 1);
      assert.ok(result.entries[0].title.includes('Naming'));
    });

    it('combined AND/OR/NOT', async () => {
      const result = await store.query('*', 'brief', 'MVI reducer|Real prefix');
      assert.strictEqual(result.entries.length, 2);
    });

    it('stemmed matching: reducers matches reducer', async () => {
      const result = await store.query('*', 'brief', 'reducers');
      assert.ok(result.entries.length >= 1, 'Should match via stemming');
      assert.ok(result.entries[0].title.includes('MVI'));
    });

    it('stemmed matching: exceptions matches exception', async () => {
      const result = await store.query('*', 'brief', 'exceptions');
      assert.ok(result.entries.length >= 1, 'Should match "exceptions" against "exceptions" via stemming');
    });

    it('empty filter returns all entries', async () => {
      const result = await store.query('*', 'brief', '');
      assert.strictEqual(result.entries.length, 4);
    });
  });

  describe('title-weighted scoring', () => {
    beforeEach(async () => {
      await store.store('architecture', 'MVI Architecture', 'This repo uses MVI pattern with standalone reducers');
      await store.store('conventions', 'State Management', 'We follow MVI conventions for state');
    });

    it('title matches rank higher than content-only matches', async () => {
      const result = await store.query('*', 'brief', 'MVI');
      assert.ok(result.entries.length >= 2);
      assert.ok(result.entries[0].title.includes('MVI'), 'Title match should rank first');
    });

    it('relevance score accounts for multiple matching terms', async () => {
      await store.store('architecture', 'Standalone Reducers', 'Reducer classes use inject constructor pattern');
      const result = await store.query('*', 'brief', 'reducer');
      assert.ok(result.entries[0].title.includes('Reducer'), 'Title match should rank first');
    });
  });

  describe('parseFilter', () => {
    it('parses simple single term', () => {
      const groups = parseFilter('reducer');
      assert.strictEqual(groups.length, 1);
      assert.ok(groups[0].must.has('reducer'));
      assert.strictEqual(groups[0].mustNot.size, 0);
    });

    it('parses space-separated AND terms', () => {
      const groups = parseFilter('reducer sealed');
      assert.strictEqual(groups.length, 1);
      assert.ok(groups[0].must.has('reducer'));
      assert.ok(groups[0].must.has('seal'));  // stemmed
    });

    it('parses pipe-separated OR groups', () => {
      const groups = parseFilter('reducer|MVI');
      assert.strictEqual(groups.length, 2);
      assert.ok(groups[0].must.has('reducer'));
      assert.ok(groups[1].must.has('mvi'));
    });

    it('parses minus-prefixed exclusions', () => {
      const groups = parseFilter('reducer -deprecated');
      assert.strictEqual(groups.length, 1);
      assert.ok(groups[0].must.has('reducer'));
      assert.ok(groups[0].mustNot.has('deprecat'));  // stemmed: deprecated -> deprecat
    });

    it('parses complex combined expression', () => {
      const groups = parseFilter('kotlin sealed|swift protocol -deprecated');
      assert.strictEqual(groups.length, 2);
      assert.ok(groups[0].must.has('kotlin'));
      assert.ok(groups[0].must.has('seal'));
      assert.ok(groups[1].must.has('swift'));
      assert.ok(groups[1].must.has('protocol'));
      assert.ok(groups[1].mustNot.has('deprecat'));
    });

    it('handles empty filter', () => {
      const groups = parseFilter('');
      assert.strictEqual(groups.length, 0);
    });
  });

  describe('corrupt file handling', () => {
    it('tracks corrupt files in stats', async () => {
      // Store a valid entry
      await store.store('architecture', 'Valid Entry', 'This is valid content');
      
      // Manually write a corrupt file
      const corruptDir = path.join(tempDir, '.memory', 'architecture');
      await fs.writeFile(path.join(corruptDir, 'corrupt-001.md'), 'not a valid entry format');
      
      // Reload and check stats
      const store2 = new MarkdownMemoryStore(makeConfig(tempDir));
      await store2.init();
      const stats = await store2.stats();
      
      assert.strictEqual(stats.totalEntries, 1); // only the valid one
      assert.strictEqual(stats.corruptFiles, 1); // the corrupt one tracked
    });
  });

  describe('boundary validation', () => {
    it('rejects entries with invalid topic on reload', async () => {
      // Manually write a file with an invalid topic
      const badDir = path.join(tempDir, '.memory', 'badtopic');
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(path.join(badDir, 'bad-001.md'), [
        '# Bad Entry',
        '- **id**: bad-001',
        '- **topic**: banana',
        '- **confidence**: 0.7',
        '- **trust**: agent-inferred',
        '- **created**: 2025-01-01T00:00:00.000Z',
        '- **lastAccessed**: 2025-01-01T00:00:00.000Z',
        '',
        'This entry has an invalid topic.',
      ].join('\n'));
      
      const store2 = new MarkdownMemoryStore(makeConfig(tempDir));
      await store2.init();
      const stats = await store2.stats();
      
      // Invalid topic entry should be rejected as corrupt
      assert.strictEqual(stats.corruptFiles, 1);
    });
  });
});
