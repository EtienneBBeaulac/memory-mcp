import { describe, it } from 'node:test';
import assert from 'node:assert';
import { keywordRank, type RankContext } from '../ranking.js';
import type { MemoryEntry, TopicScope, TrustLevel, Tag } from '../types.js';
import { extractKeywords } from '../text-analyzer.js';
import { TOPIC_BOOST, REFERENCE_BOOST_MULTIPLIER, TAG_MATCH_BOOST, MODULE_TOPIC_BOOST } from '../thresholds.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a minimal MemoryEntry for testing. Only required fields; optional ones omitted. */
function makeEntry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'title' | 'content'>): MemoryEntry {
  return {
    topic: 'architecture' as TopicScope,
    confidence: 1.0,
    trust: 'agent-confirmed' as TrustLevel,
    sources: [],
    created: '2025-01-01T00:00:00Z',
    lastAccessed: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Build a default RankContext. All entries fresh by default. */
function makeCtx(overrides?: Partial<RankContext>, freshIds?: string[]): RankContext {
  return {
    currentBranch: 'main',
    branchFilter: undefined,
    topicBoost: TOPIC_BOOST,
    freshEntryIds: new Set(freshIds ?? []),
    ...overrides,
  };
}

// ─── Basic keyword matching ───────────────────────────────────────────────

describe('keywordRank', () => {
  describe('basic matching', () => {
    it('returns empty for no entries', () => {
      const results = keywordRank([], extractKeywords('kotlin coroutines'), 0.2, makeCtx());
      assert.strictEqual(results.length, 0);
    });

    it('matches entries by shared keywords', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Kotlin Coroutines', content: 'Use structured concurrency for coroutines' }),
        makeEntry({ id: 'b', title: 'Swift UI', content: 'Layout with SwiftUI modifiers' }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin coroutines'), 0.2, makeCtx({}, ['a', 'b']));

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].entry.id, 'a');
      assert.ok(results[0].matchedKeywords.length > 0);
    });

    it('returns empty when no keywords match', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Kotlin Coroutines', content: 'Use structured concurrency' }),
      ];
      const results = keywordRank(entries, extractKeywords('quantum computing algorithms'), 0.2, makeCtx({}, ['a']));
      assert.strictEqual(results.length, 0);
    });

    it('returns empty when context keywords are empty', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Kotlin', content: 'stuff' }),
      ];
      const results = keywordRank(entries, new Set(), 0.2, makeCtx({}, ['a']));
      assert.strictEqual(results.length, 0);
    });
  });

  // ─── minMatch threshold ───────────────────────────────────────────────

  describe('minMatch threshold', () => {
    it('excludes entries below minMatch ratio', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Kotlin', content: 'Kotlin basics' }),
      ];
      // Query has 5 context keywords, entry matches ~1 → ratio ~0.2
      // With minMatch 0.5, should be excluded
      const results = keywordRank(
        entries,
        extractKeywords('kotlin coroutines flow testing reducer'),
        0.5,
        makeCtx({}, ['a']),
      );
      assert.strictEqual(results.length, 0);
    });

    it('includes entries at or above minMatch ratio', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Kotlin Coroutines', content: 'Kotlin coroutines with flow' }),
      ];
      const results = keywordRank(
        entries,
        extractKeywords('kotlin coroutines flow'),
        0.2,
        makeCtx({}, ['a']),
      );
      assert.ok(results.length > 0, 'Should include entry with sufficient keyword overlap');
    });
  });

  // ─── Scoring ──────────────────────────────────────────────────────────

  describe('scoring', () => {
    it('higher confidence entries score higher', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Kotlin Patterns', content: 'Kotlin design patterns', confidence: 0.5 }),
        makeEntry({ id: 'b', title: 'Kotlin Architecture', content: 'Kotlin architecture patterns', confidence: 1.0 }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin patterns'), 0.2, makeCtx({}, ['a', 'b']));

      assert.ok(results.length === 2);
      assert.strictEqual(results[0].entry.id, 'b', 'Higher confidence should rank first');
      assert.ok(results[0].score > results[1].score);
    });

    it('topic boost affects ordering', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Kotlin gotcha', content: 'Kotlin null safety gotcha', topic: 'gotchas' as TopicScope }),
        makeEntry({ id: 'b', title: 'Kotlin arch', content: 'Kotlin architecture patterns', topic: 'architecture' as TopicScope }),
      ];
      // gotchas boost (1.5) > architecture boost (1.0)
      const results = keywordRank(entries, extractKeywords('kotlin'), 0.2, makeCtx({}, ['a', 'b']));

      assert.ok(results.length === 2);
      assert.strictEqual(results[0].entry.id, 'a', 'Gotchas topic should score higher due to topic boost');
    });

    it('stale entries get 0.7x freshness multiplier', () => {
      const entries = [
        makeEntry({ id: 'fresh', title: 'Kotlin Fresh', content: 'Fresh kotlin info' }),
        makeEntry({ id: 'stale', title: 'Kotlin Stale', content: 'Stale kotlin info' }),
      ];
      // Only 'fresh' is in freshEntryIds — 'stale' gets 0.7 multiplier
      const results = keywordRank(entries, extractKeywords('kotlin'), 0.2, makeCtx({}, ['fresh']));

      assert.ok(results.length === 2);
      assert.strictEqual(results[0].entry.id, 'fresh', 'Fresh entry should rank first');
      // Score ratio should be approximately 1.0 / 0.7 ≈ 1.43
      const ratio = results[0].score / results[1].score;
      assert.ok(Math.abs(ratio - (1.0 / 0.7)) < 0.01, `Score ratio should be ~1.43, got ${ratio}`);
    });

    it('module topic gets MODULE_TOPIC_BOOST', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Module auth patterns', content: 'Auth module kotlin patterns', topic: 'modules/auth' as TopicScope }),
        makeEntry({ id: 'b', title: 'Arch patterns', content: 'Architecture kotlin patterns', topic: 'architecture' as TopicScope }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin patterns'), 0.2, makeCtx({}, ['a', 'b']));

      // modules/auth gets MODULE_TOPIC_BOOST (1.1), architecture gets 1.0
      const moduleResult = results.find(r => r.entry.id === 'a')!;
      const archResult = results.find(r => r.entry.id === 'b')!;
      assert.ok(moduleResult.score > archResult.score, 'Module topic should score higher than base architecture');
    });
  });

  // ─── Reference boost ──────────────────────────────────────────────────

  describe('reference boost', () => {
    it('boosts entries whose references match context keywords', () => {
      const entries = [
        makeEntry({
          id: 'ref',
          title: 'State Machine',
          content: 'Kotlin state machine patterns',
          references: ['com/app/MessagingReducer.kt'],
        }),
        makeEntry({
          id: 'noref',
          title: 'State Handler',
          content: 'Kotlin state handler patterns',
        }),
      ];
      const results = keywordRank(
        entries,
        extractKeywords('MessagingReducer state transitions'),
        0.2,
        makeCtx({}, ['ref', 'noref']),
      );

      const refResult = results.find(r => r.entry.id === 'ref')!;
      const noRefResult = results.find(r => r.entry.id === 'noref')!;
      assert.ok(refResult, 'Referenced entry should appear');
      assert.ok(noRefResult, 'Non-referenced entry should appear');
      assert.ok(refResult.score > noRefResult.score, 'Referenced entry should score higher');
    });
  });

  // ─── Tag boost ────────────────────────────────────────────────────────

  describe('tag boost', () => {
    it('boosts entries whose tags match context keywords', () => {
      const entries = [
        makeEntry({
          id: 'tagged',
          title: 'Kotlin info',
          content: 'Kotlin concurrency patterns',
          tags: ['concurrency' as Tag],
        }),
        makeEntry({
          id: 'untagged',
          title: 'Kotlin info',
          content: 'Kotlin concurrency patterns',
        }),
      ];
      const results = keywordRank(
        entries,
        extractKeywords('kotlin concurrency'),
        0.2,
        makeCtx({}, ['tagged', 'untagged']),
      );

      const taggedResult = results.find(r => r.entry.id === 'tagged')!;
      const untaggedResult = results.find(r => r.entry.id === 'untagged')!;
      assert.ok(taggedResult.score > untaggedResult.score, 'Tagged entry should score higher');
    });

    it('tags are included as searchable keywords', () => {
      const entries = [
        makeEntry({
          id: 'a',
          title: 'Some Pattern',
          content: 'Architecture decision record',
          tags: ['adr' as Tag],
        }),
      ];
      // 'adr' is only in tags, not title or content
      const results = keywordRank(entries, extractKeywords('adr'), 0.2, makeCtx({}, ['a']));
      assert.ok(results.length > 0, 'Tag-only keyword should match');
    });
  });

  // ─── Branch filtering ─────────────────────────────────────────────────

  describe('branch filtering', () => {
    it('filters recent-work by current branch', () => {
      const entries = [
        makeEntry({
          id: 'a',
          title: 'Work on auth',
          content: 'Auth feature kotlin work',
          topic: 'recent-work' as TopicScope,
          branch: 'feature/auth',
        }),
        makeEntry({
          id: 'b',
          title: 'Work on main',
          content: 'Main branch kotlin work',
          topic: 'recent-work' as TopicScope,
          branch: 'main',
        }),
      ];
      const results = keywordRank(
        entries,
        extractKeywords('kotlin work'),
        0.2,
        makeCtx({ currentBranch: 'main' }, ['a', 'b']),
      );

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].entry.id, 'b');
    });

    it('shows all recent-work when branchFilter is "*"', () => {
      const entries = [
        makeEntry({
          id: 'a',
          title: 'Work on auth',
          content: 'Auth feature kotlin work',
          topic: 'recent-work' as TopicScope,
          branch: 'feature/auth',
        }),
        makeEntry({
          id: 'b',
          title: 'Work on main',
          content: 'Main branch kotlin work',
          topic: 'recent-work' as TopicScope,
          branch: 'main',
        }),
      ];
      const results = keywordRank(
        entries,
        extractKeywords('kotlin work'),
        0.2,
        makeCtx({ currentBranch: 'main', branchFilter: '*' }, ['a', 'b']),
      );

      assert.strictEqual(results.length, 2);
    });

    it('includes recent-work without branch set', () => {
      const entries = [
        makeEntry({
          id: 'a',
          title: 'Recent kotlin work',
          content: 'Kotlin recent work item',
          topic: 'recent-work' as TopicScope,
          // no branch set
        }),
      ];
      const results = keywordRank(
        entries,
        extractKeywords('kotlin work'),
        0.2,
        makeCtx({ currentBranch: 'main' }, ['a']),
      );

      assert.strictEqual(results.length, 1, 'recent-work without branch should always be included');
    });

    it('does not filter non-recent-work by branch', () => {
      const entries = [
        makeEntry({
          id: 'a',
          title: 'Architecture kotlin patterns',
          content: 'Kotlin architecture work',
          topic: 'architecture' as TopicScope,
          branch: 'feature/other',
        }),
      ];
      const results = keywordRank(
        entries,
        extractKeywords('kotlin architecture'),
        0.2,
        makeCtx({ currentBranch: 'main' }, ['a']),
      );

      assert.strictEqual(results.length, 1, 'Non-recent-work should not be filtered by branch');
    });
  });

  // ─── Sort order ───────────────────────────────────────────────────────

  describe('sort order', () => {
    it('returns results sorted by score descending', () => {
      const entries = [
        makeEntry({ id: 'low', title: 'Kotlin basics', content: 'Simple kotlin', confidence: 0.3, topic: 'architecture' as TopicScope }),
        makeEntry({ id: 'high', title: 'Kotlin patterns', content: 'Advanced kotlin', confidence: 1.0, topic: 'gotchas' as TopicScope }),
        makeEntry({ id: 'mid', title: 'Kotlin style', content: 'Kotlin coding style', confidence: 0.7, topic: 'conventions' as TopicScope }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin'), 0.2, makeCtx({}, ['low', 'high', 'mid']));

      assert.ok(results.length === 3);
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].score >= results[i].score,
          `Result ${i - 1} (${results[i - 1].score}) should score >= result ${i} (${results[i].score})`);
      }
    });
  });

  // ─── Does NOT include user entries policy ─────────────────────────────

  describe('user entry policy', () => {
    it('does not auto-include user entries (that is contextSearch policy)', () => {
      const entries = [
        makeEntry({ id: 'user1', title: 'About me', content: 'My developer profile', topic: 'user' as TopicScope }),
      ];
      // Query about something unrelated — user entry shouldn't auto-include in keywordRank
      const results = keywordRank(entries, extractKeywords('quantum computing'), 0.2, makeCtx({}, ['user1']));
      assert.strictEqual(results.length, 0, 'keywordRank should NOT auto-include user entries');
    });
  });
});
