import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeArgs } from '../normalize.js';

describe('normalizeArgs', () => {
  const singleLobe = ['my-repo'] as const;
  const multiLobe = ['repo-a', 'repo-b'] as const;

  describe('param alias resolution', () => {
    it('resolves "key" to "title"', () => {
      const result = normalizeArgs('memory_store', { key: 'Test' }, singleLobe);
      assert.strictEqual(result['title'], 'Test');
      assert.strictEqual(result['key'], undefined);
    });

    it('resolves "name" to "title"', () => {
      const result = normalizeArgs('memory_store', { name: 'Test' }, singleLobe);
      assert.strictEqual(result['title'], 'Test');
    });

    it('resolves "value" to "content"', () => {
      const result = normalizeArgs('memory_store', { value: 'some text' }, singleLobe);
      assert.strictEqual(result['content'], 'some text');
    });

    it('resolves "body" to "content"', () => {
      const result = normalizeArgs('memory_store', { body: 'data' }, singleLobe);
      assert.strictEqual(result['content'], 'data');
    });

    it('resolves "text" to "content"', () => {
      const result = normalizeArgs('memory_store', { text: 'hello' }, singleLobe);
      assert.strictEqual(result['content'], 'hello');
    });

    it('resolves "query" to "filter"', () => {
      const result = normalizeArgs('memory_query', { query: 'MVI' }, singleLobe);
      assert.strictEqual(result['filter'], 'MVI');
    });

    it('resolves "search" to "filter"', () => {
      const result = normalizeArgs('memory_query', { search: 'reducer' }, singleLobe);
      assert.strictEqual(result['filter'], 'reducer');
    });

    it('resolves "workspace" to "lobe"', () => {
      const result = normalizeArgs('memory_store', { workspace: 'my-repo' }, singleLobe);
      assert.strictEqual(result['lobe'], 'my-repo');
    });

    it('resolves "repo" to "lobe"', () => {
      const result = normalizeArgs('memory_store', { repo: 'my-repo' }, singleLobe);
      assert.strictEqual(result['lobe'], 'my-repo');
    });

    it('resolves "description" to "context"', () => {
      const result = normalizeArgs('memory_context', { description: 'writing code' }, singleLobe);
      assert.strictEqual(result['context'], 'writing code');
    });

    it('resolves "task" to "context"', () => {
      const result = normalizeArgs('memory_context', { task: 'refactoring' }, singleLobe);
      assert.strictEqual(result['context'], 'refactoring');
    });

    it('does not overwrite existing canonical param', () => {
      const result = normalizeArgs('memory_store', { key: 'aliased', title: 'canonical' }, singleLobe);
      assert.strictEqual(result['title'], 'canonical');
    });
  });

  describe('scope alias for memory_store', () => {
    it('resolves "scope" to "topic" for memory_store', () => {
      const result = normalizeArgs('memory_store', { scope: 'architecture' }, singleLobe);
      assert.strictEqual(result['topic'], 'architecture');
      assert.strictEqual(result['scope'], undefined);
    });

    it('does not resolve "scope" to "topic" for other tools', () => {
      const result = normalizeArgs('memory_query', { scope: 'architecture' }, singleLobe);
      assert.strictEqual(result['scope'], 'architecture');
      assert.strictEqual(result['topic'], undefined);
    });

    it('does not overwrite existing "topic"', () => {
      const result = normalizeArgs('memory_store', { scope: 'gotchas', topic: 'architecture' }, singleLobe);
      assert.strictEqual(result['topic'], 'architecture');
    });
  });

  describe('lobe defaulting', () => {
    it('defaults lobe to single available lobe when omitted', () => {
      const result = normalizeArgs('memory_store', { topic: 'architecture' }, singleLobe);
      assert.strictEqual(result['lobe'], 'my-repo');
    });

    it('defaults lobe when empty string', () => {
      const result = normalizeArgs('memory_store', { lobe: '' }, singleLobe);
      assert.strictEqual(result['lobe'], 'my-repo');
    });

    it('defaults lobe when undefined', () => {
      const result = normalizeArgs('memory_store', { lobe: undefined }, singleLobe);
      assert.strictEqual(result['lobe'], 'my-repo');
    });

    it('does not default lobe when multiple lobes available', () => {
      const result = normalizeArgs('memory_store', {}, multiLobe);
      assert.strictEqual(result['lobe'], undefined);
    });

    it('preserves explicit lobe', () => {
      const result = normalizeArgs('memory_store', { lobe: 'repo-b' }, multiLobe);
      assert.strictEqual(result['lobe'], 'repo-b');
    });
  });

  describe('wildcard scope normalization', () => {
    it('normalizes "all" to "*"', () => {
      const result = normalizeArgs('memory_query', { scope: 'all' }, singleLobe);
      assert.strictEqual(result['scope'], '*');
    });

    it('normalizes "everything" to "*"', () => {
      const result = normalizeArgs('memory_query', { scope: 'everything' }, singleLobe);
      assert.strictEqual(result['scope'], '*');
    });

    it('normalizes "global" to "*"', () => {
      const result = normalizeArgs('memory_query', { scope: 'global' }, singleLobe);
      assert.strictEqual(result['scope'], '*');
    });

    it('normalizes "project" to "*"', () => {
      const result = normalizeArgs('memory_query', { scope: 'project' }, singleLobe);
      assert.strictEqual(result['scope'], '*');
    });

    it('is case-insensitive', () => {
      const result = normalizeArgs('memory_query', { scope: 'ALL' }, singleLobe);
      assert.strictEqual(result['scope'], '*');
    });

    it('does not touch valid scopes', () => {
      const result = normalizeArgs('memory_query', { scope: 'architecture' }, singleLobe);
      assert.strictEqual(result['scope'], 'architecture');
    });

    it('passes through "*" unchanged', () => {
      const result = normalizeArgs('memory_query', { scope: '*' }, singleLobe);
      assert.strictEqual(result['scope'], '*');
    });
  });

  describe('query scope defaulting', () => {
    it('defaults scope to "*" when filter is present but scope is missing', () => {
      const result = normalizeArgs('memory_query', { filter: 'MVI' }, singleLobe);
      assert.strictEqual(result['scope'], '*');
    });

    it('does not default scope when scope is already present', () => {
      const result = normalizeArgs('memory_query', { filter: 'MVI', scope: 'architecture' }, singleLobe);
      assert.strictEqual(result['scope'], 'architecture');
    });

    it('does not default scope for non-query tools', () => {
      const result = normalizeArgs('memory_store', { filter: 'MVI' }, singleLobe);
      assert.strictEqual(result['scope'], undefined);
    });
  });

  describe('branch wildcard normalization', () => {
    it('normalizes "all" branch to "*"', () => {
      const result = normalizeArgs('memory_query', { scope: '*', branch: 'all' }, singleLobe);
      assert.strictEqual(result['branch'], '*');
    });

    it('normalizes "everything" branch to "*"', () => {
      const result = normalizeArgs('memory_query', { scope: '*', branch: 'everything' }, singleLobe);
      assert.strictEqual(result['branch'], '*');
    });

    it('does not touch real branch names', () => {
      const result = normalizeArgs('memory_query', { scope: '*', branch: 'feature/auth' }, singleLobe);
      assert.strictEqual(result['branch'], 'feature/auth');
    });
  });

  describe('handles undefined/null input', () => {
    it('handles undefined raw args', () => {
      const result = normalizeArgs('memory_store', undefined, singleLobe);
      assert.ok(result);
      assert.strictEqual(result['lobe'], 'my-repo');
    });
  });
});
