// Tests for lobe-resolution.ts — pure lobe resolution logic.
// Tests the path-matching algorithm and the degradation ladder.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchRootsToLobeNames, buildLobeResolution, type ClientRoot, type LobeRootConfig } from '../lobe-resolution.js';

// --- Helpers ---

function roots(...uris: string[]): readonly ClientRoot[] {
  return uris.map(uri => ({ uri }));
}

function lobes(...configs: Array<[string, string]>): readonly LobeRootConfig[] {
  return configs.map(([name, repoRoot]) => ({ name, repoRoot }));
}

// --- matchRootsToLobeNames ---

describe('matchRootsToLobeNames', () => {
  describe('basic matching', () => {
    it('matches exact file:// URI to lobe root', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow'),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, ['zillow']);
    });

    it('matches when client root is a child of lobe root', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow/features/messaging'),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, ['zillow']);
    });

    it('matches when lobe root is a child of client root (monorepo parent)', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects'),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, ['zillow']);
    });

    it('returns empty array when no roots match any lobe', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/unrelated'),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, []);
    });

    it('handles bare paths (no file:// scheme)', () => {
      const result = matchRootsToLobeNames(
        roots('/Users/me/projects/zillow'),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, ['zillow']);
    });
  });

  describe('multi-lobe discrimination', () => {
    const twoLobes = lobes(
      ['zillow', '/Users/me/projects/zillow'],
      ['eidola', '/Users/me/projects/eidola'],
    );

    it('matches only the correct lobe when roots are unambiguous', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow'),
        twoLobes,
      );
      assert.deepStrictEqual(result, ['zillow']);
    });

    it('does not match an unrelated lobe', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow'),
        twoLobes,
      );
      assert.ok(!result.includes('eidola'), 'should not match eidola');
    });

    it('matches multiple lobes when client root is a common parent', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects'),
        twoLobes,
      );
      // Both are children of /Users/me/projects
      assert.deepStrictEqual(new Set(result), new Set(['zillow', 'eidola']));
    });

    it('matches multiple lobes when multiple roots are provided', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow', 'file:///Users/me/projects/eidola'),
        twoLobes,
      );
      assert.deepStrictEqual(new Set(result), new Set(['zillow', 'eidola']));
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty roots', () => {
      const result = matchRootsToLobeNames(
        [],
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, []);
    });

    it('returns empty array for empty lobe configs', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow'),
        [],
      );
      assert.deepStrictEqual(result, []);
    });

    it('does not false-match on path prefix overlap (zillow vs zillow-tools)', () => {
      // /Users/me/projects/zillow-tools starts with /Users/me/projects/zillow
      // but they are sibling directories, not parent/child — must not match
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow-tools'),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, []);
    });

    it('does not false-match lobe root on similar client root prefix', () => {
      // Reverse direction: lobe root is the longer path
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow'),
        lobes(['zillow-tools', '/Users/me/projects/zillow-tools']),
      );
      assert.deepStrictEqual(result, []);
    });

    it('matches when paths are identical (exact match)', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow'),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, ['zillow']);
    });

    it('matches with trailing slash on root URI', () => {
      const result = matchRootsToLobeNames(
        roots('file:///Users/me/projects/zillow/'),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, ['zillow']);
    });

    it('deduplicates when multiple roots match the same lobe', () => {
      const result = matchRootsToLobeNames(
        roots(
          'file:///Users/me/projects/zillow',
          'file:///Users/me/projects/zillow/features',
        ),
        lobes(['zillow', '/Users/me/projects/zillow']),
      );
      assert.deepStrictEqual(result, ['zillow']);
    });
  });
});

// --- buildLobeResolution ---

describe('buildLobeResolution', () => {
  describe('single lobe', () => {
    it('always resolves to the single lobe regardless of matched lobes', () => {
      const result = buildLobeResolution(['my-project'], []);
      assert.strictEqual(result.kind, 'resolved');
      if (result.kind === 'resolved') {
        assert.deepStrictEqual(result.lobes, ['my-project']);
        assert.strictEqual(result.label, 'my-project');
      }
    });

    it('resolves even when matched lobes is non-empty', () => {
      const result = buildLobeResolution(['my-project'], ['my-project']);
      assert.strictEqual(result.kind, 'resolved');
    });
  });

  describe('multiple lobes with matches', () => {
    it('resolves to matched lobes with single label', () => {
      const result = buildLobeResolution(['zillow', 'eidola'], ['zillow']);
      assert.strictEqual(result.kind, 'resolved');
      if (result.kind === 'resolved') {
        assert.deepStrictEqual(result.lobes, ['zillow']);
        assert.strictEqual(result.label, 'zillow');
      }
    });

    it('resolves to multiple matched lobes with joined label', () => {
      const result = buildLobeResolution(['zillow', 'eidola', 'tooling'], ['zillow', 'tooling']);
      assert.strictEqual(result.kind, 'resolved');
      if (result.kind === 'resolved') {
        assert.deepStrictEqual(result.lobes, ['zillow', 'tooling']);
        assert.strictEqual(result.label, 'zillow+tooling');
      }
    });
  });

  describe('multiple lobes with no matches', () => {
    it('returns global-only with hint listing available lobes', () => {
      const result = buildLobeResolution(['zillow', 'eidola'], []);
      assert.strictEqual(result.kind, 'global-only');
      if (result.kind === 'global-only') {
        assert.ok(result.hint.includes('zillow'), 'hint should mention zillow');
        assert.ok(result.hint.includes('eidola'), 'hint should mention eidola');
        assert.ok(result.hint.includes('Specify lobe parameter'), 'hint should suggest specifying lobe');
      }
    });
  });
});
