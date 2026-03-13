// Embedding provider boundary — the only seam that touches embedding infrastructure.
// Injected into the store for testability; FakeEmbedder for tests, OllamaEmbedder for production.
//
// Design:
//   - Errors are data: EmbedResult discriminated union, never throws
//   - Small interface: one method + one property. Batch is a standalone utility.
//   - Cancellation first-class: AbortSignal propagated through embed()
//   - Graceful degradation: embed failure → keyword-only search, never a crash

import http from 'node:http';
import type { EmbeddingVector } from './types.js';
import { asEmbeddingVector } from './types.js';

// ─── Result types ──────────────────────────────────────────────────────────

/** Why embedding failed — discriminated union for observability.
 *  The store doesn't branch on the reason (always falls back to keywords),
 *  but structured errors enable logging and diagnostics. */
export type EmbedFailure =
  | { readonly kind: 'provider-unavailable'; readonly reason: string }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'invalid-input'; readonly reason: string };

/** Embedding outcome — success carries the vector, failure carries structured diagnostics.
 *  Matches the StoreResult/CorrectResult pattern from types.ts. */
export type EmbedResult =
  | { readonly ok: true; readonly vector: EmbeddingVector }
  | { readonly ok: false; readonly failure: EmbedFailure };

// ─── Interface ─────────────────────────────────────────────────────────────

/** Embedding provider boundary — injected into the store.
 *  Implementations: OllamaEmbedder (production), FakeEmbedder (tests).
 *
 *  Minimal interface: one method + one property.
 *  No isAvailable() — redundant with embed() returning a failure.
 *  No embedBatch() — interface segregation; batch is a standalone utility. */
export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<EmbedResult>;
  readonly dimensions: number;
}

// ─── OllamaEmbedder ───────────────────────────────────────────────────────

/** Default timeout for embed calls — generous for cold model loads */
const DEFAULT_TIMEOUT_MS = 5000;

/** Production embedder using local Ollama instance.
 *  Uses node:http directly — no external dependencies. */
export class OllamaEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts?: {
    readonly model?: string;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly dimensions?: number;
  }) {
    this.model = opts?.model ?? 'nomic-embed-text';
    this.baseUrl = opts?.baseUrl ?? 'http://localhost:11434';
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dimensions = opts?.dimensions ?? 384;
  }

  async embed(text: string, signal?: AbortSignal): Promise<EmbedResult> {
    // Validate at boundary — no HTTP call wasted on empty input
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, failure: { kind: 'invalid-input', reason: 'empty text' } };
    }

    // Compose caller's signal with internal timeout
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const body = JSON.stringify({ model: this.model, prompt: trimmed });
    const url = new URL('/api/embeddings', this.baseUrl);

    const httpResult = await httpPost(url, body, combinedSignal);

    // HTTP layer failed — map to embed failure
    if (!httpResult.ok) {
      if (httpResult.failure === 'aborted') {
        return { ok: false, failure: { kind: 'timeout', ms: this.timeoutMs } };
      }
      return { ok: false, failure: { kind: 'provider-unavailable', reason: httpResult.failure } };
    }

    const response = httpResult.body;

    // Validate response shape — Ollama returns { embedding: number[] }
    if (!response.embedding || !Array.isArray(response.embedding)) {
      return {
        ok: false,
        failure: { kind: 'provider-unavailable', reason: 'unexpected response format — missing embedding array' },
      };
    }

    // Validate array contents — coercion to Float32Array silently produces NaN for non-numbers
    if (response.embedding.length > 0 && typeof response.embedding[0] !== 'number') {
      return {
        ok: false,
        failure: { kind: 'provider-unavailable', reason: 'embedding array contains non-numeric values' },
      };
    }

    const vector = asEmbeddingVector(new Float32Array(response.embedding as number[]));

    // Dimension sanity check — catches model mismatch at boundary
    if (vector.length !== this.dimensions) {
      return {
        ok: false,
        failure: {
          kind: 'provider-unavailable',
          reason: `dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
        },
      };
    }

    return { ok: true, vector };
  }
}

// ─── FakeEmbedder ─────────────────────────────────────────────────────────

/** Deterministic embedder for testing — uses character trigram frequency to produce
 *  a fixed-dimension vector from input text. Same text → same vector. Similar texts
 *  → high cosine similarity. Dissimilar texts → low cosine similarity.
 *
 *  Limitation: models *string* similarity, not *semantic* similarity.
 *  "async workflows" and "asynchronous work patterns" score low despite being
 *  semantically identical. FakeEmbedder tests prove pipeline mechanics (merge,
 *  degradation, round-trip). Real semantic ordering is tested separately with
 *  fixture vectors from nomic-embed-text. */
export class FakeEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string, _signal?: AbortSignal): Promise<EmbedResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, failure: { kind: 'invalid-input', reason: 'empty text' } };
    }

    const vector = trigramVector(trimmed, this.dimensions);
    return { ok: true, vector };
  }
}

/** Produce a deterministic vector from text using character trigram frequency.
 *  Each trigram hashes to a bucket (dimension index). The resulting vector is
 *  L2-normalized so cosine similarity between two vectors is meaningful.
 *
 *  Pure function — no side effects, deterministic. */
function trigramVector(text: string, dimensions: number): EmbeddingVector {
  const normalized = text.toLowerCase();
  const raw = new Float32Array(dimensions);

  // Accumulate trigram counts into dimension buckets
  for (let i = 0; i <= normalized.length - 3; i++) {
    const trigram = normalized.substring(i, i + 3);
    const bucket = trigramHash(trigram, dimensions);
    raw[bucket] += 1;
  }

  // L2 normalize — cosine similarity requires unit-length or at least
  // consistent normalization to be meaningful
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += raw[i] * raw[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      raw[i] /= norm;
    }
  }

  return asEmbeddingVector(raw);
}

/** Simple hash of a trigram string to a bucket index.
 *  Deterministic: same trigram always maps to the same bucket. */
function trigramHash(trigram: string, buckets: number): number {
  let hash = 0;
  for (let i = 0; i < trigram.length; i++) {
    hash = ((hash << 5) - hash + trigram.charCodeAt(i)) | 0;
  }
  return ((hash % buckets) + buckets) % buckets;
}

// ─── Batch utility ────────────────────────────────────────────────────────

/** Batch embed texts sequentially. Pure composition over Embedder.embed().
 *  Sequential because local Ollama benefits from serialized requests (single GPU/CPU).
 *  Not on the interface — interface segregation. */
export async function batchEmbed(
  embedder: Embedder,
  texts: readonly string[],
): Promise<ReadonlyArray<EmbedResult>> {
  const results: EmbedResult[] = [];
  for (const text of texts) {
    results.push(await embedder.embed(text));
  }
  return results;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────

/** HTTP POST outcome — errors are data, not exceptions.
 *  'aborted' is a distinct failure kind so callers can map it to timeout. */
type HttpPostResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly failure: string | 'aborted' };

/** Minimal HTTP POST using node:http — returns a result type, never throws.
 *  No external dependencies — the Ollama API is simple enough for raw HTTP.
 *
 *  Uses a settled guard to prevent double-resolution when abort races with
 *  a network error (req.destroy triggers error handler alongside abort handler). */
function httpPost(url: URL, body: string, signal: AbortSignal): Promise<HttpPostResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: HttpPostResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    // Already aborted before we start — fail fast
    if (signal.aborted) {
      resolve({ ok: false, failure: 'aborted' });
      return;
    }

    const onAbort = () => {
      req.destroy();
      settle({ ok: false, failure: 'aborted' });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            settle({ ok: false, failure: `HTTP ${res.statusCode}: ${raw.slice(0, 200)}` });
            return;
          }

          try {
            settle({ ok: true, body: JSON.parse(raw) as Record<string, unknown> });
          } catch {
            settle({ ok: false, failure: `invalid JSON response: ${raw.slice(0, 200)}` });
          }
        });
        res.on('error', (err) => {
          settle({ ok: false, failure: err.message });
        });
      },
    );

    req.on('error', (err) => {
      settle({ ok: false, failure: err.message });
    });

    req.write(body);
    req.end();
  });
}
