import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { MarkdownMemoryStore } from '../store.js';
import type { MemoryConfig, Clock } from '../types.js';
import { DEFAULT_STORAGE_BUDGET_BYTES, parseTopicScope, parseTrustLevel } from '../types.js';

// --- Fake clock: deterministic time for testing staleness ---

function fakeClock(isoDate: string): Clock {
  const date = new Date(isoDate);
  return {
    now: () => new Date(date.getTime()),
    isoNow: () => date.toISOString(),
  };
}

function makeConfig(repoRoot: string, clock?: Clock): MemoryConfig {
  return {
    repoRoot,
    memoryPath: path.join(repoRoot, '.memory'),
    storageBudgetBytes: DEFAULT_STORAGE_BUDGET_BYTES,
    clock,
  };
}

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-clock-test-'));
}

// --- parseTopicScope tests ---

describe('parseTopicScope', () => {
  it('accepts all fixed topics', () => {
    const fixed = ['user', 'preferences', 'architecture', 'conventions', 'gotchas', 'recent-work'];
    for (const topic of fixed) {
      assert.strictEqual(parseTopicScope(topic), topic, `Should accept "${topic}"`);
    }
  });

  it('accepts modules/ prefixed topics', () => {
    assert.strictEqual(parseTopicScope('modules/messaging'), 'modules/messaging');
    assert.strictEqual(parseTopicScope('modules/auth'), 'modules/auth');
    assert.strictEqual(parseTopicScope('modules/deep/nested'), 'modules/deep/nested');
  });

  it('rejects empty string', () => {
    assert.strictEqual(parseTopicScope(''), null);
  });

  it('rejects arbitrary strings', () => {
    assert.strictEqual(parseTopicScope('banana'), null);
    assert.strictEqual(parseTopicScope('foobar'), null);
    assert.strictEqual(parseTopicScope('arch'), null);
  });

  it('rejects "modules/" without a name', () => {
    assert.strictEqual(parseTopicScope('modules/'), null);
  });

  it('is case-sensitive', () => {
    assert.strictEqual(parseTopicScope('Architecture'), null);
    assert.strictEqual(parseTopicScope('USER'), null);
  });
});

// --- parseTrustLevel tests ---

describe('parseTrustLevel', () => {
  it('accepts all valid trust levels', () => {
    assert.strictEqual(parseTrustLevel('user'), 'user');
    assert.strictEqual(parseTrustLevel('agent-confirmed'), 'agent-confirmed');
    assert.strictEqual(parseTrustLevel('agent-inferred'), 'agent-inferred');
  });

  it('rejects arbitrary strings', () => {
    assert.strictEqual(parseTrustLevel('admin'), null);
    assert.strictEqual(parseTrustLevel(''), null);
    assert.strictEqual(parseTrustLevel('USER'), null);
  });
});

// --- Fake clock: staleness and freshness ---

describe('Clock injection for freshness', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  it('entries older than 30 days are stale with fake clock', async () => {
    // Store entries with a clock set to Jan 1, 2025
    const jan1 = fakeClock('2025-01-01T00:00:00.000Z');
    const store1 = new MarkdownMemoryStore(makeConfig(tempDir, jan1));
    await store1.init();

    await store1.store('architecture', 'Old Pattern', 'This was stored long ago', [], 'agent-inferred');

    // Query with a clock set to Mar 1, 2025 (59 days later — well past 30)
    const mar1 = fakeClock('2025-03-01T00:00:00.000Z');
    const store2 = new MarkdownMemoryStore(makeConfig(tempDir, mar1));
    await store2.init();

    const result = await store2.query('architecture', 'brief');
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].fresh, false, 'Entry should be stale after 59 days');
  });

  it('entries within 30 days are fresh with fake clock', async () => {
    const jan1 = fakeClock('2025-01-01T00:00:00.000Z');
    const store1 = new MarkdownMemoryStore(makeConfig(tempDir, jan1));
    await store1.init();

    await store1.store('architecture', 'Recent Pattern', 'Just stored', [], 'agent-inferred');

    // Query 15 days later — still within 30
    const jan16 = fakeClock('2025-01-16T00:00:00.000Z');
    const store2 = new MarkdownMemoryStore(makeConfig(tempDir, jan16));
    await store2.init();

    const result = await store2.query('architecture', 'brief');
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].fresh, true, 'Entry should be fresh within 30 days');
  });

  it('user and preference entries are always fresh regardless of age', async () => {
    const jan1 = fakeClock('2025-01-01T00:00:00.000Z');
    const store1 = new MarkdownMemoryStore(makeConfig(tempDir, jan1));
    await store1.init();

    await store1.store('user', 'Identity', 'An engineer', [], 'user');
    await store1.store('preferences', 'Style', 'Functional first', [], 'user');

    // Query 1 year later
    const nextYear = fakeClock('2026-01-01T00:00:00.000Z');
    const store2 = new MarkdownMemoryStore(makeConfig(tempDir, nextYear));
    await store2.init();

    const result = await store2.query('*', 'brief');
    for (const entry of result.entries) {
      assert.strictEqual(entry.fresh, true, `"${entry.title}" should be always-fresh`);
    }
  });

  it('gotchas are always fresh regardless of age', async () => {
    const jan1 = fakeClock('2025-01-01T00:00:00.000Z');
    const store1 = new MarkdownMemoryStore(makeConfig(tempDir, jan1));
    await store1.init();

    await store1.store('gotchas', 'Build Gotcha', 'Always clean build', [], 'agent-inferred');

    const nextYear = fakeClock('2026-01-01T00:00:00.000Z');
    const store2 = new MarkdownMemoryStore(makeConfig(tempDir, nextYear));
    await store2.init();

    const result = await store2.query('gotchas', 'brief');
    assert.strictEqual(result.entries[0].fresh, true, 'Gotchas should be always-fresh');
  });

  it('user-trusted entries are always fresh regardless of age', async () => {
    const jan1 = fakeClock('2025-01-01T00:00:00.000Z');
    const store1 = new MarkdownMemoryStore(makeConfig(tempDir, jan1));
    await store1.init();

    await store1.store('conventions', 'User Convention', 'User said so', [], 'user');

    const nextYear = fakeClock('2026-01-01T00:00:00.000Z');
    const store2 = new MarkdownMemoryStore(makeConfig(tempDir, nextYear));
    await store2.init();

    const result = await store2.query('conventions', 'brief');
    assert.strictEqual(result.entries[0].fresh, true, 'User-trusted entries should be always-fresh');
  });

  it('stale count in briefing reflects clock-based freshness', async () => {
    const jan1 = fakeClock('2025-01-01T00:00:00.000Z');
    const store1 = new MarkdownMemoryStore(makeConfig(tempDir, jan1));
    await store1.init();

    await store1.store('architecture', 'Old Arch', 'content', [], 'agent-inferred');
    await store1.store('conventions', 'Old Conv', 'content', [], 'agent-confirmed');
    await store1.store('gotchas', 'Gotcha', 'content', [], 'agent-inferred'); // always fresh

    // Briefing 60 days later
    const mar2 = fakeClock('2025-03-02T00:00:00.000Z');
    const store2 = new MarkdownMemoryStore(makeConfig(tempDir, mar2));
    await store2.init();

    const briefing = await store2.briefing(2000);
    // arch + conv are stale (agent-inferred/confirmed, >30 days), gotcha is always-fresh
    assert.strictEqual(briefing.staleEntries, 2, 'Should have 2 stale entries');
  });

  it('clock is used for created/lastAccessed timestamps', async () => {
    const fixedTime = fakeClock('2025-06-15T12:30:00.000Z');
    const store1 = new MarkdownMemoryStore(makeConfig(tempDir, fixedTime));
    await store1.init();

    await store1.store('architecture', 'Test Entry', 'content');
    const result = await store1.query('architecture', 'full');

    assert.strictEqual(result.entries[0].created, '2025-06-15T12:30:00.000Z');
    assert.strictEqual(result.entries[0].lastAccessed, '2025-06-15T12:30:00.000Z');
  });
});

// --- Confidence range validation ---

describe('confidence clamping on disk read', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  it('clamps out-of-range confidence to valid range on reload', async () => {
    const store1 = new MarkdownMemoryStore(makeConfig(tempDir));
    await store1.init();

    // Manually write a file with confidence: 999
    const dir = path.join(tempDir, '.memory', 'architecture');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'arch-bad1.md'), [
      '# High Confidence',
      '- **id**: arch-bad1',
      '- **topic**: architecture',
      '- **confidence**: 999',
      '- **trust**: agent-inferred',
      '- **created**: 2025-01-01T00:00:00.000Z',
      '- **lastAccessed**: 2025-01-01T00:00:00.000Z',
      '',
      'This entry has absurd confidence.',
    ].join('\n'));

    // Manually write a file with confidence: -5
    await fs.writeFile(path.join(dir, 'arch-bad2.md'), [
      '# Negative Confidence',
      '- **id**: arch-bad2',
      '- **topic**: architecture',
      '- **confidence**: -5',
      '- **trust**: agent-inferred',
      '- **created**: 2025-01-01T00:00:00.000Z',
      '- **lastAccessed**: 2025-01-01T00:00:00.000Z',
      '',
      'This entry has negative confidence.',
    ].join('\n'));

    const store2 = new MarkdownMemoryStore(makeConfig(tempDir));
    await store2.init();
    const result = await store2.query('architecture', 'full');

    assert.strictEqual(result.entries.length, 2);
    for (const entry of result.entries) {
      assert.ok(entry.confidence >= 0.0, `Confidence ${entry.confidence} should be >= 0.0`);
      assert.ok(entry.confidence <= 1.0, `Confidence ${entry.confidence} should be <= 1.0`);
    }
  });
});
