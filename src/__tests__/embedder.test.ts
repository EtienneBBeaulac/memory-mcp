import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FakeEmbedder, OllamaEmbedder, batchEmbed } from '../embedder.js';
import type { Embedder, EmbedResult } from '../embedder.js';
import { asEmbeddingVector } from '../types.js';
import type { EmbeddingVector } from '../types.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Cosine similarity between two vectors — duplicated here intentionally.
 *  text-analyzer.ts will get the real implementation in Step 2.
 *  Having it here avoids a cross-dependency and makes these tests self-contained. */
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

/** Stub embedder that always fails — for testing degradation paths */
class FailingEmbedder implements Embedder {
  readonly dimensions = 384;
  readonly failureKind: 'provider-unavailable' | 'timeout';

  constructor(failureKind: 'provider-unavailable' | 'timeout' = 'provider-unavailable') {
    this.failureKind = failureKind;
  }

  async embed(_text: string): Promise<EmbedResult> {
    if (this.failureKind === 'timeout') {
      return { ok: false, failure: { kind: 'timeout', ms: 5000 } };
    }
    return { ok: false, failure: { kind: 'provider-unavailable', reason: 'test failure' } };
  }
}

// ─── FakeEmbedder ──────────────────────────────────────────────────────────

describe('FakeEmbedder', () => {
  const embedder = new FakeEmbedder(384);

  it('produces a vector with correct dimensions', async () => {
    const result = await embedder.embed('hello world');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.vector.length, 384);
  });

  it('determinism: same text produces identical vector', async () => {
    const a = await embedder.embed('FlowCoordinator uses a state machine');
    const b = await embedder.embed('FlowCoordinator uses a state machine');
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;

    // Byte-for-byte identical
    assert.deepStrictEqual(Array.from(a.vector), Array.from(b.vector));
  });

  it('similar texts produce high cosine similarity', async () => {
    const a = await embedder.embed('token refresh race condition in auth module');
    const b = await embedder.embed('auth token refresh has a race condition');
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;

    const sim = cosine(a.vector, b.vector);
    assert.ok(sim > 0.7, `Expected high similarity for similar text, got ${sim}`);
  });

  it('dissimilar texts produce low cosine similarity', async () => {
    const a = await embedder.embed('token refresh race condition in auth module');
    const b = await embedder.embed('CSS grid layout patterns for responsive design');
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;

    const sim = cosine(a.vector, b.vector);
    assert.ok(sim < 0.5, `Expected low similarity for dissimilar text, got ${sim}`);
  });

  it('returns failure for empty text', async () => {
    const result = await embedder.embed('');
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.strictEqual(result.failure.kind, 'invalid-input');
  });

  it('returns failure for whitespace-only text', async () => {
    const result = await embedder.embed('   \n\t  ');
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.strictEqual(result.failure.kind, 'invalid-input');
  });

  it('produces L2-normalized vectors', async () => {
    const result = await embedder.embed('some reasonable text content');
    assert.ok(result.ok);
    if (!result.ok) return;

    // L2 norm should be ≈1.0 for normalized vectors
    let norm = 0;
    for (let i = 0; i < result.vector.length; i++) {
      norm += result.vector[i] * result.vector[i];
    }
    norm = Math.sqrt(norm);
    assert.ok(
      Math.abs(norm - 1.0) < 0.001,
      `Expected L2 norm ≈ 1.0, got ${norm}`,
    );
  });

  it('respects custom dimensions', async () => {
    const small = new FakeEmbedder(64);
    const result = await small.embed('test text');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.vector.length, 64);
  });

  it('short text (< 3 chars) produces zero vector — documented behavior', async () => {
    // Text shorter than 3 chars produces zero trigrams → zero vector.
    // cosine similarity with any other vector is 0. This is honest: there is
    // no information to embed. The text passes the empty check (it is non-empty)
    // but produces no useful signal.
    const result = await embedder.embed('ab');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.vector.length, 384);

    // Verify it's a zero vector — all dimensions should be 0
    let norm = 0;
    for (let i = 0; i < result.vector.length; i++) {
      norm += result.vector[i] * result.vector[i];
    }
    assert.strictEqual(norm, 0, 'Short text should produce a zero vector (no trigrams)');
  });
});

// ─── OllamaEmbedder (structural tests only — no live Ollama) ──────────────

describe('OllamaEmbedder', () => {
  it('rejects empty text without making HTTP call', async () => {
    // Even with a bogus URL, empty text should fail fast with invalid-input
    const embedder = new OllamaEmbedder({ baseUrl: 'http://localhost:99999' });
    const result = await embedder.embed('');
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.strictEqual(result.failure.kind, 'invalid-input');
  });

  it('returns provider-unavailable when Ollama is not running', async () => {
    // Port 1 is almost certainly not running Ollama
    const embedder = new OllamaEmbedder({ baseUrl: 'http://localhost:1', timeoutMs: 500 });
    const result = await embedder.embed('test');
    assert.ok(!result.ok);
    if (result.ok) return;
    // Could be provider-unavailable (connection refused) or timeout
    assert.ok(
      result.failure.kind === 'provider-unavailable' || result.failure.kind === 'timeout',
      `Expected provider-unavailable or timeout, got ${result.failure.kind}`,
    );
  });

  it('respects caller abort signal', async () => {
    const controller = new AbortController();
    // Abort immediately
    controller.abort();

    const embedder = new OllamaEmbedder({ baseUrl: 'http://localhost:11434' });
    const result = await embedder.embed('test', controller.signal);
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.strictEqual(result.failure.kind, 'timeout');
  });

  it('exposes correct default dimensions', () => {
    const embedder = new OllamaEmbedder();
    assert.strictEqual(embedder.dimensions, 384);
  });

  it('accepts custom configuration', () => {
    const embedder = new OllamaEmbedder({
      model: 'custom-model',
      baseUrl: 'http://custom:8080',
      timeoutMs: 10000,
      dimensions: 768,
    });
    assert.strictEqual(embedder.dimensions, 768);
  });
});

// ─── batchEmbed ────────────────────────────────────────────────────────────

describe('batchEmbed', () => {
  it('embeds all texts sequentially', async () => {
    const embedder = new FakeEmbedder(64);
    const texts = ['hello world', 'foo bar baz', 'another text here'];
    const results = await batchEmbed(embedder, texts);

    assert.strictEqual(results.length, 3);
    for (const result of results) {
      assert.ok(result.ok, 'All results should succeed with FakeEmbedder');
    }
  });

  it('handles empty input array', async () => {
    const embedder = new FakeEmbedder(64);
    const results = await batchEmbed(embedder, []);
    assert.strictEqual(results.length, 0);
  });

  it('handles mixed success and failure', async () => {
    const embedder = new FakeEmbedder(64);
    const texts = ['valid text', '', 'another valid text'];
    const results = await batchEmbed(embedder, texts);

    assert.strictEqual(results.length, 3);
    assert.ok(results[0].ok, 'First should succeed');
    assert.ok(!results[1].ok, 'Second (empty) should fail');
    assert.ok(results[2].ok, 'Third should succeed');

    if (!results[1].ok) {
      assert.strictEqual(results[1].failure.kind, 'invalid-input');
    }
  });

  it('propagates all failures from a failing embedder', async () => {
    const embedder = new FailingEmbedder('provider-unavailable');
    const texts = ['text one', 'text two'];
    const results = await batchEmbed(embedder, texts);

    assert.strictEqual(results.length, 2);
    for (const result of results) {
      assert.ok(!result.ok);
      if (!result.ok) {
        assert.strictEqual(result.failure.kind, 'provider-unavailable');
      }
    }
  });
});

// ─── EmbedResult type contracts ────────────────────────────────────────────

describe('EmbedResult contracts', () => {
  it('success result carries vector, no failure', async () => {
    const embedder = new FakeEmbedder(64);
    const result = await embedder.embed('test');
    if (result.ok) {
      assert.ok(result.vector instanceof Float32Array);
      assert.strictEqual(result.vector.length, 64);
      // TypeScript ensures `result.failure` does not exist on the ok branch
    }
  });

  it('failure result carries structured failure, no vector', async () => {
    const embedder = new FakeEmbedder(64);
    const result = await embedder.embed('');
    if (!result.ok) {
      assert.ok('kind' in result.failure);
      assert.strictEqual(result.failure.kind, 'invalid-input');
      assert.ok('reason' in result.failure);
      // TypeScript ensures `result.vector` does not exist on the failure branch
    }
  });

  it('timeout failure carries duration', async () => {
    const embedder = new FailingEmbedder('timeout');
    const result = await embedder.embed('test');
    assert.ok(!result.ok);
    if (!result.ok && result.failure.kind === 'timeout') {
      assert.strictEqual(result.failure.ms, 5000);
    }
  });
});

// ─── EmbeddingVector branding ──────────────────────────────────────────────

describe('EmbeddingVector', () => {
  it('asEmbeddingVector preserves Float32Array data', () => {
    const raw = new Float32Array([1.0, 2.0, 3.0]);
    const branded = asEmbeddingVector(raw);

    assert.strictEqual(branded.length, 3);
    assert.strictEqual(branded[0], 1.0);
    assert.strictEqual(branded[1], 2.0);
    assert.strictEqual(branded[2], 3.0);
  });

  it('branded vector works with cosine similarity', () => {
    const a = asEmbeddingVector(new Float32Array([1, 0, 0]));
    const b = asEmbeddingVector(new Float32Array([1, 0, 0]));
    assert.strictEqual(cosine(a, b), 1.0);
  });

  it('orthogonal vectors produce zero similarity', () => {
    const a = asEmbeddingVector(new Float32Array([1, 0, 0]));
    const b = asEmbeddingVector(new Float32Array([0, 1, 0]));
    assert.strictEqual(cosine(a, b), 0);
  });

  it('zero vector produces zero similarity (not NaN)', () => {
    const a = asEmbeddingVector(new Float32Array([1, 0, 0]));
    const zero = asEmbeddingVector(new Float32Array([0, 0, 0]));
    const result = cosine(a, zero);
    assert.strictEqual(result, 0);
    assert.ok(!Number.isNaN(result), 'Should not produce NaN');
  });
});
