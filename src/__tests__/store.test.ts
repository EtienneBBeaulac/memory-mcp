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

  // ────────────────────────────────────────────────────────────────────────────
  // BehaviorConfig: user-overridable thresholds
  // ────────────────────────────────────────────────────────────────────────────

  describe('BehaviorConfig overrides', () => {
    it('staleDaysStandard overrides the default 30-day standard threshold', async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const pastClock = { now: () => eightDaysAgo, isoNow: () => eightDaysAgo.toISOString() };

      // Scenario A: default threshold (30 days) — 8-day-old entry should be fresh
      const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-beh-a-'));
      try {
        const pastStoreA = new MarkdownMemoryStore({ repoRoot: dirA, memoryPath: path.join(dirA, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES, clock: pastClock });
        await pastStoreA.init();
        await pastStoreA.store('architecture', 'Recent Pattern', 'An architecture pattern written 8 days ago');
        const defaultStore = new MarkdownMemoryStore({ repoRoot: dirA, memoryPath: path.join(dirA, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES });
        await defaultStore.init();
        const resultA = await defaultStore.query('architecture', 'brief');
        assert.ok(resultA.entries[0].fresh, 'Should be fresh under default 30-day threshold');
      } finally {
        await fs.rm(dirA, { recursive: true, force: true }).catch(() => {});
      }

      // Scenario B: staleDaysStandard: 5 — 8-day-old entry should be stale
      const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-beh-b-'));
      try {
        const pastStoreB = new MarkdownMemoryStore({ repoRoot: dirB, memoryPath: path.join(dirB, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES, clock: pastClock });
        await pastStoreB.init();
        await pastStoreB.store('architecture', 'Recent Pattern', 'An architecture pattern written 8 days ago');
        const strictStore = new MarkdownMemoryStore({ repoRoot: dirB, memoryPath: path.join(dirB, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES, behavior: { staleDaysStandard: 5 } });
        await strictStore.init();
        const resultB = await strictStore.query('architecture', 'brief');
        assert.ok(!resultB.entries[0].fresh, 'Should be stale under custom 5-day threshold');
      } finally {
        await fs.rm(dirB, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('staleDaysPreferences overrides the default 90-day preferences threshold', async () => {
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      const pastClock = { now: () => fortyDaysAgo, isoNow: () => fortyDaysAgo.toISOString() };

      // Scenario A: default (90 days) — 40-day-old preference should be fresh
      const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-pref-a-'));
      try {
        const pastA = new MarkdownMemoryStore({ repoRoot: dirA, memoryPath: path.join(dirA, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES, clock: pastClock });
        await pastA.init();
        await pastA.store('preferences', 'Old Pref', 'Preference written 40 days ago');
        const readA = new MarkdownMemoryStore({ repoRoot: dirA, memoryPath: path.join(dirA, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES });
        await readA.init();
        const resultA = await readA.query('preferences', 'brief');
        assert.ok(resultA.entries[0].fresh, 'Should be fresh under default 90-day threshold');
      } finally {
        await fs.rm(dirA, { recursive: true, force: true }).catch(() => {});
      }

      // Scenario B: staleDaysPreferences: 30 — 40-day-old preference should be stale
      const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-pref-b-'));
      try {
        const pastB = new MarkdownMemoryStore({ repoRoot: dirB, memoryPath: path.join(dirB, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES, clock: pastClock });
        await pastB.init();
        await pastB.store('preferences', 'Old Pref', 'Preference written 40 days ago');
        const strictB = new MarkdownMemoryStore({ repoRoot: dirB, memoryPath: path.join(dirB, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES, behavior: { staleDaysPreferences: 30 } });
        await strictB.init();
        const resultB = await strictB.query('preferences', 'brief');
        assert.ok(!resultB.entries[0].fresh, 'Should be stale under custom 30-day preferences threshold');
      } finally {
        await fs.rm(dirB, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('maxStaleInBriefing caps the number of stale entries surfaced', async () => {
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      const pastClock = { now: () => thirtyFiveDaysAgo, isoNow: () => thirtyFiveDaysAgo.toISOString() };

      const pastStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), clock: pastClock });
      await pastStore.init();
      for (let i = 0; i < 6; i++) {
        await pastStore.store('architecture', `Pattern ${i}`, `Architecture content for entry number ${i}`);
      }

      // Default cap: 5
      const defaultStore = new MarkdownMemoryStore(makeConfig(tempDir));
      await defaultStore.init();
      const defaultBriefing = await defaultStore.briefing(5000);
      assert.ok(defaultBriefing.staleDetails && defaultBriefing.staleDetails.length <= 5, `Default cap: should be ≤ 5, got ${defaultBriefing.staleDetails?.length}`);

      // Custom cap: 2
      const limitedStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), behavior: { maxStaleInBriefing: 2 } });
      await limitedStore.init();
      const limitedBriefing = await limitedStore.briefing(5000);
      assert.ok(limitedBriefing.staleDetails && limitedBriefing.staleDetails.length <= 2, `Custom cap: should be ≤ 2, got ${limitedBriefing.staleDetails?.length}`);
    });

    it('maxDedupSuggestions limits dedup results at write time', async () => {
      // Create 4 similar entries first
      const sharedContent = 'MVI architecture uses standalone reducers with sealed interface events and state management';
      for (let i = 0; i < 4; i++) {
        await store.store('architecture', `Pattern Base ${i}`, `${sharedContent} variation ${i}`);
      }

      // Store a new similar entry with maxDedupSuggestions: 1
      const limitedStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), behavior: { maxDedupSuggestions: 1 } });
      await limitedStore.init();
      const result = await limitedStore.store('architecture', 'New MVI Entry', `${sharedContent} new pattern`);

      assert.ok(result.stored);
      if (!result.stored) return;
      // Should surface at most 1 dedup suggestion even though 4 similar entries exist
      assert.ok(!result.relatedEntries || result.relatedEntries.length <= 1, `Should have at most 1 dedup suggestion, got ${result.relatedEntries?.length}`);
    });

    it('maxConflictPairs limits conflicts per query response', async () => {
      // Create 4 very similar entries across topics
      const sharedContent = 'This codebase uses MVI architecture with standalone reducers sealed interfaces events and ViewModel orchestration following clean architecture principles with Kotlin coroutines';
      const ids: string[] = [];
      const topics = ['architecture', 'conventions', 'gotchas', 'recent-work'] as const;
      for (const topic of topics) {
        const r = await store.store(topic, `MVI Overview ${topic}`, `${sharedContent} in ${topic}`);
        assert.ok(r.stored);
        if (r.stored) ids.push(r.id);
      }

      // With maxConflictPairs: 1
      const limitedStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), behavior: { maxConflictPairs: 1 } });
      await limitedStore.init();
      const entries = limitedStore.getEntriesByIds(ids);
      const conflicts = limitedStore.detectConflicts(entries);

      assert.ok(conflicts.length <= 1, `Should return at most 1 conflict pair, got ${conflicts.length}`);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Feature 1: references field
  // ────────────────────────────────────────────────────────────────────────────

  describe('references field', () => {
    it('stores and persists references to disk', async () => {
      const refs = ['features/messaging/impl/MessagingReducer.kt', 'features/messaging/impl/MessagingState.kt'];
      const result = await store.store('architecture', 'Messaging Reducer', 'Standalone reducer for messaging state', [], 'agent-inferred', refs);
      assert.ok(result.stored);
      if (!result.stored) return;

      // Verify raw file contains references metadata line
      const filePath = path.join(tempDir, '.memory', 'architecture', `${result.id}.md`);
      const raw = await fs.readFile(filePath, 'utf-8');
      assert.ok(raw.includes('- **references**: features/messaging/impl/MessagingReducer.kt, features/messaging/impl/MessagingState.kt'));
    });

    it('parses references back from disk on reload', async () => {
      const refs = ['features/messaging/impl/MessagingReducer.kt'];
      const storeResult = await store.store('architecture', 'Reducer Entry', 'Uses MVI reducer pattern', [], 'agent-inferred', refs);
      assert.ok(storeResult.stored);

      // Force reload from disk with a fresh store instance
      const store2 = new MarkdownMemoryStore(makeConfig(tempDir));
      await store2.init();
      const query = await store2.query('architecture', 'full');

      const entry = query.entries.find(e => e.title === 'Reducer Entry');
      assert.ok(entry, 'Entry should exist after reload');
      assert.deepStrictEqual(entry!.references, ['features/messaging/impl/MessagingReducer.kt']);
    });

    it('surfaces references in full detail query', async () => {
      const refs = ['src/Foo.kt', 'src/Bar.kt'];
      await store.store('conventions', 'Foo Pattern', 'Uses Foo and Bar pattern', [], 'agent-inferred', refs);
      const result = await store.query('conventions', 'full');

      assert.ok(result.entries.length === 1);
      assert.deepStrictEqual(result.entries[0].references, ['src/Foo.kt', 'src/Bar.kt']);
    });

    it('surfaces references in standard detail query', async () => {
      const refs = ['src/Foo.kt'];
      await store.store('conventions', 'Foo Pattern', 'Uses Foo pattern', [], 'agent-inferred', refs);
      const result = await store.query('conventions', 'standard');

      assert.deepStrictEqual(result.entries[0].references, ['src/Foo.kt']);
    });

    it('omits references in brief detail query', async () => {
      const refs = ['src/Foo.kt'];
      await store.store('conventions', 'Foo Pattern', 'Uses Foo pattern', [], 'agent-inferred', refs);
      const result = await store.query('conventions', 'brief');

      assert.ok(!result.entries[0].references, 'Brief detail should not include references');
    });

    it('omits references metadata line when empty', async () => {
      const result = await store.store('architecture', 'No Refs Entry', 'Content without references');
      assert.ok(result.stored);
      if (!result.stored) return;
      const filePath = path.join(tempDir, '.memory', 'architecture', `${result.id}.md`);
      const raw = await fs.readFile(filePath, 'utf-8');
      assert.ok(!raw.includes('- **references**:'), 'Should not write references line when empty');
    });

    it('boosts context search score when reference path matches context keyword', async () => {
      // Entry with reference to MessagingReducer should rank above a similar entry without it
      const withRef = await store.store('architecture', 'State Machine', 'Handles state transitions for features', [], 'agent-inferred', ['features/messaging/impl/MessagingReducer.kt']);
      const withoutRef = await store.store('architecture', 'State Handler', 'Handles state transitions for features using patterns', [], 'agent-inferred', []);
      assert.ok(withRef.stored && withoutRef.stored);

      const results = await store.contextSearch('MessagingReducer state transitions');
      const refEntry = results.find(r => r.entry.title === 'State Machine');
      const noRefEntry = results.find(r => r.entry.title === 'State Handler');

      assert.ok(refEntry, 'Entry with reference should appear in results');
      assert.ok(noRefEntry, 'Entry without reference should also appear');
      assert.ok(refEntry!.score > noRefEntry!.score, `Entry with matching reference (score: ${refEntry!.score}) should rank higher than entry without (score: ${noRefEntry!.score})`);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Feature 2: Staleness — tiered isFresh() thresholds
  // ────────────────────────────────────────────────────────────────────────────

  describe('staleness and isFresh() thresholds', () => {
    it('user topic entries are never stale regardless of age', async () => {
      const pastClock = {
        now: () => new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days ago
        isoNow: () => new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      };
      const oldStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), clock: pastClock });
      await oldStore.init();
      await oldStore.store('user', 'Identity', 'Etienne, Senior Engineer', [], 'user');

      const currentStore = new MarkdownMemoryStore(makeConfig(tempDir));
      await currentStore.init();
      const query = await currentStore.query('user', 'full');
      assert.ok(query.entries[0].fresh, 'User topic entries should always be fresh');
    });

    it('preferences entries are stale after 90 days but fresh before', async () => {
      const seventyDaysAgo = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000);
      const ninetyFiveDaysAgo = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);

      const clock70 = { now: () => seventyDaysAgo, isoNow: () => seventyDaysAgo.toISOString() };
      const clock95 = { now: () => ninetyFiveDaysAgo, isoNow: () => ninetyFiveDaysAgo.toISOString() };

      // Write with 70-days-ago clock, read with current clock → 70 days elapsed → fresh
      const store70 = new MarkdownMemoryStore({ ...makeConfig(tempDir), clock: clock70 });
      await store70.init();
      await store70.store('preferences', 'Pref 70', 'Use MVI everywhere');
      // Re-read with current clock to check freshness at current time
      const currentStore70 = new MarkdownMemoryStore(makeConfig(tempDir));
      await currentStore70.init();
      const result70 = await currentStore70.query('preferences', 'brief');
      assert.ok(result70.entries[0].fresh, '70-day-old preference should be fresh (within 90-day window)');

      // New temp dir for the 95-day test — write with 95-days-ago clock, read with current clock
      const dir95 = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-stale-'));
      try {
        const store95 = new MarkdownMemoryStore({ repoRoot: dir95, memoryPath: path.join(dir95, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES, clock: clock95 });
        await store95.init();
        await store95.store('preferences', 'Pref 95', 'Use MVI everywhere');
        // Re-read with current clock to check freshness at current time
        const currentStore95 = new MarkdownMemoryStore({ repoRoot: dir95, memoryPath: path.join(dir95, '.memory'), storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES });
        await currentStore95.init();
        const result95 = await currentStore95.query('preferences', 'brief');
        assert.ok(!result95.entries[0].fresh, '95-day-old preference should be stale (exceeds 90-day window)');
      } finally {
        await fs.rm(dir95, { recursive: true, force: true });
      }
    });

    it('gotcha entries go stale after 30 days', async () => {
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      const pastClock = { now: () => thirtyFiveDaysAgo, isoNow: () => thirtyFiveDaysAgo.toISOString() };

      const pastStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), clock: pastClock });
      await pastStore.init();
      await pastStore.store('gotchas', 'Build Gotcha', 'Run pod install first');

      const currentStore = new MarkdownMemoryStore(makeConfig(tempDir));
      await currentStore.init();
      const query = await currentStore.query('gotchas', 'brief');
      assert.ok(!query.entries[0].fresh, 'Gotcha entry 35 days old should be stale');
    });

    it('user-trusted entries in non-user topics go stale normally', async () => {
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      const pastClock = { now: () => thirtyFiveDaysAgo, isoNow: () => thirtyFiveDaysAgo.toISOString() };

      const pastStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), clock: pastClock });
      await pastStore.init();
      // Explicitly user-trusted but in architecture topic
      await pastStore.store('architecture', 'Confirmed Pattern', 'Definitely uses MVI', [], 'user');

      const currentStore = new MarkdownMemoryStore(makeConfig(tempDir));
      await currentStore.init();
      const query = await currentStore.query('architecture', 'brief');
      assert.ok(!query.entries[0].fresh, 'User-trusted architecture entry should go stale (trust != temporal validity)');
    });

    it('briefing includes staleDetails for entries past their threshold', async () => {
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      const pastClock = { now: () => thirtyFiveDaysAgo, isoNow: () => thirtyFiveDaysAgo.toISOString() };

      const pastStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), clock: pastClock });
      await pastStore.init();
      await pastStore.store('architecture', 'Old Pattern', 'This was written 35 days ago');
      await pastStore.store('gotchas', 'Old Gotcha', 'This gotcha is now stale');

      const currentStore = new MarkdownMemoryStore(makeConfig(tempDir));
      await currentStore.init();
      const briefing = await currentStore.briefing(2000);

      assert.ok(briefing.staleDetails && briefing.staleDetails.length > 0, 'Should have staleDetails for old entries');
      assert.ok(briefing.staleDetails!.every(e => e.daysSinceAccess >= 35), 'All stale entries should be 35+ days old');
    });

    it('briefing staleDetails caps at 5 entries', async () => {
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      const pastClock = { now: () => thirtyFiveDaysAgo, isoNow: () => thirtyFiveDaysAgo.toISOString() };

      const pastStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), clock: pastClock });
      await pastStore.init();
      for (let i = 0; i < 8; i++) {
        await pastStore.store('architecture', `Pattern ${i}`, `Content for pattern number ${i} in the architecture`);
      }

      const currentStore = new MarkdownMemoryStore(makeConfig(tempDir));
      await currentStore.init();
      const briefing = await currentStore.briefing(2000);

      assert.ok(briefing.staleDetails && briefing.staleDetails.length <= 5, 'Should surface at most 5 stale entries');
    });

    it('briefing staleDetails prioritizes gotchas before architecture', async () => {
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      const pastClock = { now: () => thirtyFiveDaysAgo, isoNow: () => thirtyFiveDaysAgo.toISOString() };

      const pastStore = new MarkdownMemoryStore({ ...makeConfig(tempDir), clock: pastClock });
      await pastStore.init();
      await pastStore.store('architecture', 'Arch Pattern', 'Old architecture knowledge here');
      await pastStore.store('gotchas', 'Critical Gotcha', 'Old gotcha that should surface first');

      const currentStore = new MarkdownMemoryStore(makeConfig(tempDir));
      await currentStore.init();
      const briefing = await currentStore.briefing(2000);

      assert.ok(briefing.staleDetails && briefing.staleDetails.length >= 2);
      assert.strictEqual(briefing.staleDetails![0].topic, 'gotchas', 'Gotchas should appear before architecture in stale list');
    });

    it('briefing staleDetails is undefined when no stale entries', async () => {
      // Store a fresh entry (using current time, not past clock)
      await store.store('architecture', 'Fresh Pattern', 'Just written right now');

      const briefing = await store.briefing(2000);
      assert.ok(!briefing.staleDetails || briefing.staleDetails.length === 0, 'Should have no staleDetails when all entries are fresh');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Feature 3: Conflict detection
  // ────────────────────────────────────────────────────────────────────────────

  describe('conflict detection', () => {
    it('detects high-similarity entries as conflicts', async () => {
      const a = await store.store('architecture', 'MVI Architecture', 'This codebase uses MVI architecture pattern with standalone reducers and sealed interfaces for state management events');
      const b = await store.store('conventions', 'Architecture Pattern', 'This codebase uses MVI architecture with standalone reducers sealed interfaces and state management');
      assert.ok(a.stored && b.stored);
      if (!a.stored || !b.stored) return;

      // Fetch raw entries and run detection
      const entries = store.getEntriesByIds([a.id, b.id]);
      const conflicts = store.detectConflicts(entries);

      assert.ok(conflicts.length > 0, 'Should detect conflict between highly similar entries');
      assert.ok(conflicts[0].similarity > 0.6, `Similarity ${conflicts[0].similarity} should exceed 0.6`);
    });

    it('does not flag dissimilar entries', async () => {
      const a = await store.store('architecture', 'Build System', 'Uses Gradle with Kotlin DSL for build configuration and dependency management');
      const b = await store.store('conventions', 'Networking', 'Retrofit with OkHttp for HTTP requests coroutines and suspend functions');
      assert.ok(a.stored && b.stored);
      if (!a.stored || !b.stored) return;

      const entries = store.getEntriesByIds([a.id, b.id]);
      const conflicts = store.detectConflicts(entries);

      assert.strictEqual(conflicts.length, 0, 'Dissimilar entries should not be flagged as conflicts');
    });

    it('does not flag entries with short content', async () => {
      // Short content (<=50 chars) — too noisy to be meaningful
      const a = await store.store('architecture', 'Short A', 'Use MVI');
      const b = await store.store('conventions', 'Short B', 'Use MVI pattern');
      assert.ok(a.stored && b.stored);
      if (!a.stored || !b.stored) return;

      const entries = store.getEntriesByIds([a.id, b.id]);
      const conflicts = store.detectConflicts(entries);

      assert.strictEqual(conflicts.length, 0, 'Short content entries should not be flagged as conflicts');
    });

    it('caps results at 2 conflict pairs', async () => {
      // Store 4 very similar entries
      const ids: string[] = [];
      const longContent = 'MVI architecture uses standalone reducers with sealed interfaces for state management and events in Kotlin';
      for (let i = 0; i < 4; i++) {
        const r = await store.store('architecture', `Pattern ${i}`, `${longContent} variation ${i}`);
        assert.ok(r.stored);
        if (r.stored) ids.push(r.id);
      }

      const entries = store.getEntriesByIds(ids);
      const conflicts = store.detectConflicts(entries);

      assert.ok(conflicts.length <= 2, `Should return at most 2 conflict pairs, got ${conflicts.length}`);
    });

    it('detects cross-topic conflicts', async () => {
      const similarContent = 'This codebase follows strict MVI architecture with standalone reducer classes sealed interface events and ViewModel orchestration';
      const a = await store.store('architecture', 'MVI Overview', similarContent);
      const b = await store.store('conventions', 'Architecture Convention', similarContent + ' following clean architecture principles');
      assert.ok(a.stored && b.stored);
      if (!a.stored || !b.stored) return;

      const entries = store.getEntriesByIds([a.id, b.id]);
      const conflicts = store.detectConflicts(entries);

      assert.ok(conflicts.length > 0, 'Should detect cross-topic conflicts');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Ephemeral content detection at store time
  // ────────────────────────────────────────────────────────────────────────

  describe('ephemeral warnings', () => {
    it('returns ephemeralWarning for content with temporal language', async () => {
      const result = await store.store(
        'gotchas',
        'Build Issue',
        'The build is currently broken due to a Gradle sync issue that appeared today',
      );
      assert.ok(result.stored, 'Should still store the entry');
      if (!result.stored) return;
      assert.ok(result.ephemeralWarning, 'Should include ephemeral warning');
      assert.ok(result.ephemeralWarning!.includes('Temporal language'));
    });

    it('returns ephemeralWarning for fixed-bug content', async () => {
      const result = await store.store(
        'gotchas',
        'Resolved Crash',
        'The crash bug in the messaging reducer has been fixed after we updated the coroutine scope handling',
      );
      assert.ok(result.stored);
      if (!result.stored) return;
      assert.ok(result.ephemeralWarning, 'Should warn about resolved issues');
      assert.ok(result.ephemeralWarning!.includes('Resolved issue'));
    });

    it('does not return ephemeralWarning for durable content', async () => {
      const result = await store.store(
        'architecture',
        'MVI Pattern',
        'The messaging feature uses MVI with standalone reducer classes and sealed interface events for exhaustive handling',
      );
      assert.ok(result.stored);
      if (!result.stored) return;
      assert.strictEqual(result.ephemeralWarning, undefined, 'Durable content should have no ephemeral warning');
    });

    it('skips ephemeral detection for recent-work topic', async () => {
      const result = await store.store(
        'recent-work',
        'Current Investigation',
        'Currently debugging a crash that just happened today in the messaging reducer — investigating the root cause',
      );
      assert.ok(result.stored);
      if (!result.stored) return;
      assert.strictEqual(result.ephemeralWarning, undefined, 'recent-work should bypass ephemeral detection');
    });
  });
});
