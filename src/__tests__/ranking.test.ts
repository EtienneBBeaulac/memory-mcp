import { describe, it } from 'node:test';
import assert from 'node:assert';
import { keywordRank, semanticRank, mergeRankings, type RankContext, type ScoredEntry } from '../ranking.js';
import type { MemoryEntry, TopicScope, TrustLevel, Tag, EmbeddingVector } from '../types.js';
import { asEmbeddingVector } from '../types.js';
import { extractKeywords } from '../text-analyzer.js';
import { FakeEmbedder } from '../embedder.js';
import { TOPIC_BOOST, MODULE_TOPIC_BOOST } from '../thresholds.js';

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
    defaultModuleBoost: MODULE_TOPIC_BOOST,
    ...overrides,
  };
}

/** Generate a FakeEmbedder vector for text — convenience for test setup. */
async function fakeVector(text: string, dims: number = 64): Promise<EmbeddingVector> {
  const embedder = new FakeEmbedder(dims);
  const result = await embedder.embed(text);
  if (!result.ok) throw new Error(`FakeEmbedder failed: ${result.failure.kind}`);
  return result.vector;
}

/** Cosine similarity between two float arrays (test utility). */
function cosine(a: EmbeddingVector, b: EmbeddingVector): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── keywordRank ──────────────────────────────────────────────────────────

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
      assert.strictEqual(results[0].source, 'keyword');
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

  describe('minMatch threshold', () => {
    it('excludes entries below minMatch ratio', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Kotlin', content: 'Kotlin basics' }),
      ];
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
      const results = keywordRank(entries, extractKeywords('kotlin'), 0.2, makeCtx({}, ['a', 'b']));

      assert.ok(results.length === 2);
      assert.strictEqual(results[0].entry.id, 'a', 'Gotchas topic should score higher due to topic boost');
    });

    it('stale entries get 0.7x freshness multiplier', () => {
      const entries = [
        makeEntry({ id: 'fresh', title: 'Kotlin Fresh', content: 'Fresh kotlin info' }),
        makeEntry({ id: 'stale', title: 'Kotlin Stale', content: 'Stale kotlin info' }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin'), 0.2, makeCtx({}, ['fresh']));

      assert.ok(results.length === 2);
      assert.strictEqual(results[0].entry.id, 'fresh', 'Fresh entry should rank first');
      const ratio = results[0].score / results[1].score;
      assert.ok(Math.abs(ratio - (1.0 / 0.7)) < 0.01, `Score ratio should be ~1.43, got ${ratio}`);
    });

    it('module topic gets defaultModuleBoost', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Module auth patterns', content: 'Auth module kotlin patterns', topic: 'modules/auth' as TopicScope }),
        makeEntry({ id: 'b', title: 'Arch patterns', content: 'Architecture kotlin patterns', topic: 'architecture' as TopicScope }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin patterns'), 0.2, makeCtx({}, ['a', 'b']));

      const moduleResult = results.find(r => r.entry.id === 'a')!;
      const archResult = results.find(r => r.entry.id === 'b')!;
      assert.ok(moduleResult.score > archResult.score, 'Module topic should score higher than base architecture');
    });
  });

  describe('reference boost', () => {
    it('boosts entries whose references match context keywords', () => {
      const entries = [
        makeEntry({
          id: 'ref', title: 'State Machine', content: 'Kotlin state machine patterns',
          references: ['com/app/MessagingReducer.kt'],
        }),
        makeEntry({ id: 'noref', title: 'State Handler', content: 'Kotlin state handler patterns' }),
      ];
      const results = keywordRank(entries, extractKeywords('MessagingReducer state transitions'), 0.2, makeCtx({}, ['ref', 'noref']));

      const refResult = results.find(r => r.entry.id === 'ref')!;
      const noRefResult = results.find(r => r.entry.id === 'noref')!;
      assert.ok(refResult.score > noRefResult.score, 'Referenced entry should score higher');
    });
  });

  describe('tag boost', () => {
    it('boosts entries whose tags match context keywords', () => {
      const entries = [
        makeEntry({ id: 'tagged', title: 'Kotlin info', content: 'Kotlin concurrency patterns', tags: ['concurrency' as Tag] }),
        makeEntry({ id: 'untagged', title: 'Kotlin info', content: 'Kotlin concurrency patterns' }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin concurrency'), 0.2, makeCtx({}, ['tagged', 'untagged']));

      const taggedResult = results.find(r => r.entry.id === 'tagged')!;
      const untaggedResult = results.find(r => r.entry.id === 'untagged')!;
      assert.ok(taggedResult.score > untaggedResult.score, 'Tagged entry should score higher');
    });

    it('tags are included as searchable keywords', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Some Pattern', content: 'Architecture decision record', tags: ['adr' as Tag] }),
      ];
      const results = keywordRank(entries, extractKeywords('adr'), 0.2, makeCtx({}, ['a']));
      assert.ok(results.length > 0, 'Tag-only keyword should match');
    });
  });

  describe('branch filtering', () => {
    it('filters recent-work by current branch', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Work on auth', content: 'Auth feature kotlin work', topic: 'recent-work' as TopicScope, branch: 'feature/auth' }),
        makeEntry({ id: 'b', title: 'Work on main', content: 'Main branch kotlin work', topic: 'recent-work' as TopicScope, branch: 'main' }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin work'), 0.2, makeCtx({ currentBranch: 'main' }, ['a', 'b']));

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].entry.id, 'b');
    });

    it('shows all recent-work when branchFilter is "*"', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Work on auth', content: 'Auth feature kotlin work', topic: 'recent-work' as TopicScope, branch: 'feature/auth' }),
        makeEntry({ id: 'b', title: 'Work on main', content: 'Main branch kotlin work', topic: 'recent-work' as TopicScope, branch: 'main' }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin work'), 0.2, makeCtx({ currentBranch: 'main', branchFilter: '*' }, ['a', 'b']));
      assert.strictEqual(results.length, 2);
    });

    it('includes recent-work without branch set', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Recent kotlin work', content: 'Kotlin recent work item', topic: 'recent-work' as TopicScope }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin work'), 0.2, makeCtx({ currentBranch: 'main' }, ['a']));
      assert.strictEqual(results.length, 1, 'recent-work without branch should always be included');
    });

    it('does not filter non-recent-work by branch', () => {
      const entries = [
        makeEntry({ id: 'a', title: 'Architecture kotlin patterns', content: 'Kotlin architecture work', topic: 'architecture' as TopicScope, branch: 'feature/other' }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin architecture'), 0.2, makeCtx({ currentBranch: 'main' }, ['a']));
      assert.strictEqual(results.length, 1);
    });
  });

  describe('sort order and source', () => {
    it('returns results sorted by score descending with source: keyword', () => {
      const entries = [
        makeEntry({ id: 'low', title: 'Kotlin basics', content: 'Simple kotlin', confidence: 0.3, topic: 'architecture' as TopicScope }),
        makeEntry({ id: 'high', title: 'Kotlin patterns', content: 'Advanced kotlin', confidence: 1.0, topic: 'gotchas' as TopicScope }),
        makeEntry({ id: 'mid', title: 'Kotlin style', content: 'Kotlin coding style', confidence: 0.7, topic: 'conventions' as TopicScope }),
      ];
      const results = keywordRank(entries, extractKeywords('kotlin'), 0.2, makeCtx({}, ['low', 'high', 'mid']));

      assert.ok(results.length === 3);
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].score >= results[i].score);
      }
      // All keyword results have source: 'keyword'
      for (const r of results) {
        assert.strictEqual(r.source, 'keyword');
        assert.strictEqual(r.semanticSimilarity, undefined);
      }
    });
  });

  describe('user entry policy', () => {
    it('does not auto-include user entries (that is contextSearch policy)', () => {
      const entries = [
        makeEntry({ id: 'user1', title: 'About me', content: 'My developer profile', topic: 'user' as TopicScope }),
      ];
      const results = keywordRank(entries, extractKeywords('quantum computing'), 0.2, makeCtx({}, ['user1']));
      assert.strictEqual(results.length, 0, 'keywordRank should NOT auto-include user entries');
    });
  });
});

// ─── semanticRank ─────────────────────────────────────────────────────────

describe('semanticRank', () => {
  it('ranks entries by cosine similarity', async () => {
    const entries = [
      makeEntry({ id: 'close', title: 'Kotlin coroutines', content: 'Kotlin coroutines with structured concurrency' }),
      makeEntry({ id: 'far', title: 'Swift UI layout', content: 'SwiftUI view modifiers and layout' }),
    ];
    const queryVec = await fakeVector('kotlin coroutines structured concurrency');
    const vectors = new Map<string, EmbeddingVector>([
      ['close', await fakeVector('Kotlin coroutines\n\nKotlin coroutines with structured concurrency')],
      ['far', await fakeVector('Swift UI layout\n\nSwiftUI view modifiers and layout')],
    ]);

    const results = semanticRank(entries, vectors, queryVec, 0, makeCtx({}, ['close', 'far']));

    assert.ok(results.length === 2);
    assert.strictEqual(results[0].entry.id, 'close', 'More similar entry should rank first');
    assert.ok(results[0].score > results[1].score);
    assert.strictEqual(results[0].source, 'semantic');
    assert.ok(typeof results[0].semanticSimilarity === 'number');
    assert.ok(results[0].semanticSimilarity! > results[1].semanticSimilarity!);
  });

  it('filters entries below minSimilarity', async () => {
    const entries = [
      makeEntry({ id: 'a', title: 'Kotlin stuff', content: 'Kotlin patterns' }),
      makeEntry({ id: 'b', title: 'Quantum physics', content: 'Unrelated quantum topic entirely different' }),
    ];
    const queryVec = await fakeVector('kotlin coroutines');
    const vectors = new Map<string, EmbeddingVector>([
      ['a', await fakeVector('Kotlin stuff\n\nKotlin patterns')],
      ['b', await fakeVector('Quantum physics\n\nUnrelated quantum topic entirely different')],
    ]);

    // With high threshold, dissimilar entry should be filtered
    const strict = semanticRank(entries, vectors, queryVec, 0.9, makeCtx({}, ['a', 'b']));
    const lenient = semanticRank(entries, vectors, queryVec, 0, makeCtx({}, ['a', 'b']));

    assert.ok(strict.length <= lenient.length, 'Strict threshold should produce fewer results');
  });

  it('skips entries without vectors', async () => {
    const entries = [
      makeEntry({ id: 'with', title: 'Kotlin coroutines', content: 'Has a vector' }),
      makeEntry({ id: 'without', title: 'Kotlin patterns', content: 'No vector stored' }),
    ];
    const queryVec = await fakeVector('kotlin');
    const vectors = new Map<string, EmbeddingVector>([
      ['with', await fakeVector('Kotlin coroutines\n\nHas a vector')],
      // 'without' has no vector
    ]);

    const results = semanticRank(entries, vectors, queryVec, 0, makeCtx({}, ['with', 'without']));

    assert.ok(results.every(r => r.entry.id !== 'without'), 'Entry without vector should not appear');
    assert.ok(results.some(r => r.entry.id === 'with'), 'Entry with vector should appear');
  });

  it('applies confidence and topic boost', async () => {
    const entries = [
      makeEntry({ id: 'low', title: 'Kotlin info', content: 'Kotlin basics', confidence: 0.3, topic: 'architecture' as TopicScope }),
      makeEntry({ id: 'high', title: 'Kotlin info', content: 'Kotlin basics', confidence: 1.0, topic: 'gotchas' as TopicScope }),
    ];
    // Use identical text so cosine similarity is the same for both
    const vec = await fakeVector('Kotlin info\n\nKotlin basics');
    const queryVec = await fakeVector('kotlin basics');
    const vectors = new Map<string, EmbeddingVector>([
      ['low', vec],
      ['high', vec],
    ]);

    const results = semanticRank(entries, vectors, queryVec, 0, makeCtx({}, ['low', 'high']));

    assert.ok(results.length === 2);
    assert.strictEqual(results[0].entry.id, 'high', 'Higher confidence + topic boost should rank first');
  });

  it('applies freshness multiplier', async () => {
    const entries = [
      makeEntry({ id: 'fresh', title: 'Kotlin info', content: 'Same content' }),
      makeEntry({ id: 'stale', title: 'Kotlin info', content: 'Same content' }),
    ];
    const vec = await fakeVector('Kotlin info\n\nSame content');
    const queryVec = await fakeVector('kotlin');
    const vectors = new Map<string, EmbeddingVector>([['fresh', vec], ['stale', vec]]);

    // Only 'fresh' is in freshEntryIds
    const results = semanticRank(entries, vectors, queryVec, 0, makeCtx({}, ['fresh']));

    assert.ok(results.length === 2);
    assert.strictEqual(results[0].entry.id, 'fresh');
    const ratio = results[0].score / results[1].score;
    assert.ok(Math.abs(ratio - (1.0 / 0.7)) < 0.01, `Score ratio should be ~1.43, got ${ratio}`);
  });

  it('filters recent-work by branch', async () => {
    const entries = [
      makeEntry({ id: 'a', title: 'Auth work', content: 'Auth feature kotlin', topic: 'recent-work' as TopicScope, branch: 'feature/auth' }),
      makeEntry({ id: 'b', title: 'Main work', content: 'Main kotlin work', topic: 'recent-work' as TopicScope, branch: 'main' }),
    ];
    const queryVec = await fakeVector('kotlin work');
    const vectors = new Map<string, EmbeddingVector>([
      ['a', await fakeVector('Auth work\n\nAuth feature kotlin')],
      ['b', await fakeVector('Main work\n\nMain kotlin work')],
    ]);

    const results = semanticRank(entries, vectors, queryVec, 0, makeCtx({ currentBranch: 'main' }, ['a', 'b']));
    assert.ok(results.every(r => r.entry.id !== 'a'), 'Wrong-branch recent-work should be filtered');
  });

  it('returns empty for empty entries', async () => {
    const queryVec = await fakeVector('kotlin');
    const results = semanticRank([], new Map(), queryVec, 0, makeCtx());
    assert.strictEqual(results.length, 0);
  });
});

// ─── mergeRankings ────────────────────────────────────────────────────────

describe('mergeRankings', () => {
  it('merges keyword and semantic results using max score', () => {
    const kwResults: ScoredEntry[] = [
      { entry: makeEntry({ id: 'a', title: 'A', content: 'a' }), score: 2.0, matchedKeywords: ['kotlin'], source: 'keyword' },
      { entry: makeEntry({ id: 'b', title: 'B', content: 'b' }), score: 1.0, matchedKeywords: ['kotlin'], source: 'keyword' },
    ];
    const semResults: ScoredEntry[] = [
      { entry: makeEntry({ id: 'a', title: 'A', content: 'a' }), score: 1.5, matchedKeywords: [], source: 'semantic', semanticSimilarity: 0.75 },
      { entry: makeEntry({ id: 'c', title: 'C', content: 'c' }), score: 1.8, matchedKeywords: [], source: 'semantic', semanticSimilarity: 0.90 },
    ];

    const merged = mergeRankings(kwResults, semResults);

    // Entry 'a' in both lists: max(2.0, 1.5) = 2.0, source: merged
    const a = merged.find(r => r.entry.id === 'a')!;
    assert.strictEqual(a.source, 'merged');
    assert.strictEqual(a.score, 2.0);
    assert.deepStrictEqual(a.matchedKeywords, ['kotlin']); // from keyword result
    assert.strictEqual(a.semanticSimilarity, 0.75);         // from semantic result

    // Entry 'c' semantic-only
    const c = merged.find(r => r.entry.id === 'c')!;
    assert.strictEqual(c.source, 'semantic');
    assert.strictEqual(c.score, 1.8);

    // Entry 'b' keyword-only
    const b = merged.find(r => r.entry.id === 'b')!;
    assert.strictEqual(b.source, 'keyword');
    assert.strictEqual(b.score, 1.0);

    // Sorted by score descending
    assert.strictEqual(merged[0].entry.id, 'a'); // 2.0
    assert.strictEqual(merged[1].entry.id, 'c'); // 1.8
    assert.strictEqual(merged[2].entry.id, 'b'); // 1.0
  });

  it('merged entry uses semantic score when semantic > keyword', () => {
    const kwResults: ScoredEntry[] = [
      { entry: makeEntry({ id: 'a', title: 'A', content: 'a' }), score: 0.5, matchedKeywords: ['x'], source: 'keyword' },
    ];
    const semResults: ScoredEntry[] = [
      { entry: makeEntry({ id: 'a', title: 'A', content: 'a' }), score: 1.2, matchedKeywords: [], source: 'semantic', semanticSimilarity: 0.80 },
    ];

    const merged = mergeRankings(kwResults, semResults);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].score, 1.2);
    assert.strictEqual(merged[0].source, 'merged');
  });

  it('handles keyword-only input', () => {
    const kwResults: ScoredEntry[] = [
      { entry: makeEntry({ id: 'a', title: 'A', content: 'a' }), score: 1.0, matchedKeywords: ['x'], source: 'keyword' },
    ];
    const merged = mergeRankings(kwResults, []);

    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].source, 'keyword');
  });

  it('handles semantic-only input', () => {
    const semResults: ScoredEntry[] = [
      { entry: makeEntry({ id: 'a', title: 'A', content: 'a' }), score: 1.0, matchedKeywords: [], source: 'semantic', semanticSimilarity: 0.80 },
    ];
    const merged = mergeRankings([], semResults);

    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].source, 'semantic');
  });

  it('handles both empty', () => {
    const merged = mergeRankings([], []);
    assert.strictEqual(merged.length, 0);
  });

  it('deduplicates entries from both lists', () => {
    const entry = makeEntry({ id: 'x', title: 'X', content: 'x' });
    const kwResults: ScoredEntry[] = [
      { entry, score: 1.0, matchedKeywords: ['a'], source: 'keyword' },
    ];
    const semResults: ScoredEntry[] = [
      { entry, score: 0.8, matchedKeywords: [], source: 'semantic', semanticSimilarity: 0.60 },
    ];

    const merged = mergeRankings(kwResults, semResults);
    assert.strictEqual(merged.length, 1, 'Should deduplicate');
    assert.strictEqual(merged[0].source, 'merged');
  });

  it('sorts merged results by score descending', () => {
    const kwResults: ScoredEntry[] = [
      { entry: makeEntry({ id: 'a', title: 'A', content: 'a' }), score: 0.5, matchedKeywords: ['x'], source: 'keyword' },
      { entry: makeEntry({ id: 'b', title: 'B', content: 'b' }), score: 3.0, matchedKeywords: ['y'], source: 'keyword' },
    ];
    const semResults: ScoredEntry[] = [
      { entry: makeEntry({ id: 'c', title: 'C', content: 'c' }), score: 2.0, matchedKeywords: [], source: 'semantic', semanticSimilarity: 0.85 },
    ];

    const merged = mergeRankings(kwResults, semResults);
    for (let i = 1; i < merged.length; i++) {
      assert.ok(merged[i - 1].score >= merged[i].score, `Score at ${i - 1} should be >= score at ${i}`);
    }
  });
});
