import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeArgs } from '../normalize.js';

describe('normalizeArgs', () => {
  const singleLobe = ['my-repo'] as const;
  const multiLobe = ['repo-a', 'repo-b'] as const;

  describe('param alias resolution', () => {
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
      const result = normalizeArgs('memory_store', { refs: ['a.kt'], references: ['b.kt'] }, singleLobe);
      assert.deepStrictEqual(result['references'], ['b.kt']);
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

  describe('v2 tool-specific aliases', () => {
    it('resolves "query" to "context" for recall', () => {
      const result = normalizeArgs('recall', { query: 'auth flow' }, singleLobe);
      assert.strictEqual(result['context'], 'auth flow');
      assert.strictEqual(result['query'], undefined);
    });

    it('resolves "search" to "context" for recall', () => {
      const result = normalizeArgs('recall', { search: 'kotlin coroutines' }, singleLobe);
      assert.strictEqual(result['context'], 'kotlin coroutines');
    });

    it('resolves "description" to "context" for recall', () => {
      const result = normalizeArgs('recall', { description: 'working on auth' }, singleLobe);
      assert.strictEqual(result['context'], 'working on auth');
    });

    it('does not overwrite existing "context" with alias', () => {
      const result = normalizeArgs('recall', { context: 'real', query: 'alias' }, singleLobe);
      assert.strictEqual(result['context'], 'real');
    });

    it('resolves "query" to "filter" for memory_query (not context)', () => {
      const result = normalizeArgs('memory_query', { query: 'MVI' }, singleLobe);
      assert.strictEqual(result['filter'], 'MVI');
      assert.strictEqual(result['context'], undefined);
    });

    it('resolves "content" to "observation" for gotcha', () => {
      const result = normalizeArgs('gotcha', { lobe: 'x', content: 'some gotcha' }, singleLobe);
      assert.strictEqual(result['observation'], 'some gotcha');
      assert.strictEqual(result['content'], undefined);
    });

    it('resolves "note" to "observation" for convention', () => {
      const result = normalizeArgs('convention', { lobe: 'x', note: 'some convention' }, singleLobe);
      assert.strictEqual(result['observation'], 'some convention');
    });

    it('resolves "fact" to "observation" for learn', () => {
      const result = normalizeArgs('learn', { lobe: 'x', fact: 'some info' }, singleLobe);
      assert.strictEqual(result['observation'], 'some info');
    });

    it('resolves "preference" to "rule" for prefer', () => {
      const result = normalizeArgs('prefer', { preference: 'be concise' }, singleLobe);
      assert.strictEqual(result['rule'], 'be concise');
    });

    it('resolves "text" to "correction" for fix', () => {
      const result = normalizeArgs('fix', { id: 'x', text: 'new content' }, singleLobe);
      assert.strictEqual(result['correction'], 'new content');
    });

    it('resolves "query" to "area" for gotchas', () => {
      const result = normalizeArgs('gotchas', { query: 'auth' }, singleLobe);
      assert.strictEqual(result['area'], 'auth');
    });

    it('resolves "filter" to "area" for conventions', () => {
      const result = normalizeArgs('conventions', { filter: 'testing' }, singleLobe);
      assert.strictEqual(result['area'], 'testing');
    });

    // Tool-name-as-param aliases (agents pass the tool name as the param key)
    it('resolves "gotcha" to "observation" for gotcha tool', () => {
      const result = normalizeArgs('gotcha', { lobe: 'x', gotcha: 'cache is stale' }, singleLobe);
      assert.strictEqual(result['observation'], 'cache is stale');
      assert.strictEqual(result['gotcha'], undefined);
    });

    it('resolves "convention" to "observation" for convention tool', () => {
      const result = normalizeArgs('convention', { lobe: 'x', convention: 'use StateFlow' }, singleLobe);
      assert.strictEqual(result['observation'], 'use StateFlow');
      assert.strictEqual(result['convention'], undefined);
    });

    it('resolves "learn" to "observation" for learn tool', () => {
      const result = normalizeArgs('learn', { lobe: 'x', learn: 'module depends on auth' }, singleLobe);
      assert.strictEqual(result['observation'], 'module depends on auth');
      assert.strictEqual(result['learn'], undefined);
    });

    it('resolves "knowledge" to "observation" for learn tool', () => {
      const result = normalizeArgs('learn', { lobe: 'x', knowledge: 'architecture info' }, singleLobe);
      assert.strictEqual(result['observation'], 'architecture info');
    });

    it('resolves "prefer" to "rule" for prefer tool', () => {
      const result = normalizeArgs('prefer', { prefer: 'no !! operator' }, singleLobe);
      assert.strictEqual(result['rule'], 'no !! operator');
      assert.strictEqual(result['prefer'], undefined);
    });

    it('resolves "recall" to "context" for recall tool', () => {
      const result = normalizeArgs('recall', { recall: 'auth tokens' }, singleLobe);
      assert.strictEqual(result['context'], 'auth tokens');
      assert.strictEqual(result['recall'], undefined);
    });

    it('resolves "fix" to "correction" for fix tool', () => {
      const result = normalizeArgs('fix', { id: 'x', fix: 'updated info' }, singleLobe);
      assert.strictEqual(result['correction'], 'updated info');
      assert.strictEqual(result['fix'], undefined);
    });
  });
});
