import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractTitle } from '../text-analyzer.js';
import { formatLootDrop, formatSearchMode } from '../formatters.js';
import type { RelatedEntry } from '../types.js';

// ─── extractTitle ───────────────────────────────────────────────────────

describe('extractTitle', () => {
  it('extracts first sentence as title', () => {
    const result = extractTitle('Gradle cache must be cleaned. Otherwise builds use stale artifacts.');
    assert.strictEqual(result.title, 'Gradle cache must be cleaned.');
    assert.ok(result.content.includes('Gradle cache must be cleaned'));
    assert.ok(result.content.includes('Otherwise builds'));
  });

  it('uses full text when single sentence', () => {
    const result = extractTitle('All ViewModels use StateFlow for UI state');
    assert.strictEqual(result.title, 'All ViewModels use StateFlow for UI state');
    assert.strictEqual(result.content, 'All ViewModels use StateFlow for UI state');
  });

  it('handles newline as sentence boundary', () => {
    const result = extractTitle('JWT tokens expire every 30 minutes\nRefresh via AuthRefresher service');
    assert.strictEqual(result.title, 'JWT tokens expire every 30 minutes');
    assert.ok(result.content.includes('Refresh via AuthRefresher'));
  });

  it('truncates very long single sentences', () => {
    const long = 'A'.repeat(100);
    const result = extractTitle(long);
    assert.ok(result.title.length <= 80, `Title should be <= 80 chars, got ${result.title.length}`);
    assert.ok(result.title.endsWith('...'));
    assert.strictEqual(result.content, long);
  });

  it('handles empty input', () => {
    const result = extractTitle('');
    assert.strictEqual(result.title, '');
    assert.strictEqual(result.content, '');
  });

  it('handles whitespace-only input', () => {
    const result = extractTitle('   \n  ');
    assert.strictEqual(result.title, '');
    assert.strictEqual(result.content, '');
  });

  it('trims whitespace', () => {
    const result = extractTitle('  Use Anvil for DI.  ');
    assert.strictEqual(result.title, 'Use Anvil for DI.');
    assert.strictEqual(result.content, 'Use Anvil for DI.');
  });

  it('handles exclamation mark as sentence end', () => {
    const result = extractTitle('Never use force push on main! This has caused data loss before.');
    assert.strictEqual(result.title, 'Never use force push on main!');
  });

  it('handles question mark as sentence end', () => {
    const result = extractTitle('Why does the build fail? The cache is stale after Tuist changes.');
    assert.strictEqual(result.title, 'Why does the build fail?');
  });

  it('preserves full content even when title is truncated', () => {
    const long = 'This is a very long observation that spans many words and should be truncated in the title but preserved in full as the content field';
    const result = extractTitle(long);
    assert.strictEqual(result.content, long);
  });

  it('handles multi-paragraph observations', () => {
    const text = 'The auth module uses JWT tokens.\n\nTokens are refreshed every 30 minutes via the AuthRefresher service.';
    const result = extractTitle(text);
    assert.strictEqual(result.title, 'The auth module uses JWT tokens.');
    assert.ok(result.content.includes('AuthRefresher'));
  });

  it('does not split on abbreviations like e.g.', () => {
    const result = extractTitle('Use e.g. Anvil for DI. Not Dagger directly.');
    assert.strictEqual(result.title, 'Use e.g. Anvil for DI.');
  });

  it('does not split on abbreviations like U.S.', () => {
    const result = extractTitle('The U.S. build server uses M1 chips. Very fast.');
    assert.strictEqual(result.title, 'The U.S. build server uses M1 chips.');
  });

  it('handles version numbers correctly', () => {
    const result = extractTitle('Version 2.0 is required. Older versions crash.');
    assert.strictEqual(result.title, 'Version 2.0 is required.');
  });
});

// ─── formatLootDrop ─────────────────────────────────────────────────────

describe('formatLootDrop', () => {
  it('returns empty string when no related entries', () => {
    assert.strictEqual(formatLootDrop([]), '');
  });

  it('formats related entries', () => {
    const related: RelatedEntry[] = [
      { id: 'gotcha-a1b2', title: 'Tuist workspace regeneration', content: '...', confidence: 0.87, trust: 'agent-confirmed' },
      { id: 'arch-c3d4', title: 'Build system architecture', content: '...', confidence: 0.72, trust: 'agent-inferred' },
    ];
    const result = formatLootDrop(related);
    assert.ok(result.includes('Related knowledge'));
    assert.ok(result.includes('gotcha-a1b2'));
    assert.ok(result.includes('Tuist workspace regeneration'));
    assert.ok(result.includes('0.87'));
    assert.ok(result.includes('arch-c3d4'));
  });

  it('formats single related entry', () => {
    const related: RelatedEntry[] = [
      { id: 'conv-1234', title: 'StateFlow convention', content: '...', confidence: 0.95, trust: 'user' },
    ];
    const result = formatLootDrop(related);
    assert.ok(result.includes('conv-1234'));
    assert.ok(result.includes('StateFlow convention'));
  });
});

// ─── formatSearchMode ───────────────────────────────────────────────────

describe('formatSearchMode', () => {
  it('shows semantic + keyword when embedder available and vectors exist', () => {
    const result = formatSearchMode(true, 47, 52);
    assert.ok(result.includes('semantic'), `Should mention semantic: ${result}`);
    assert.ok(result.includes('keyword'), `Should mention keyword: ${result}`);
    assert.ok(result.includes('47'), `Should include vector count: ${result}`);
  });

  it('shows keyword-only when embedder unavailable', () => {
    const result = formatSearchMode(false, 0, 50);
    assert.ok(result.includes('keyword'), `Should mention keyword: ${result}`);
  });

  it('shows hint about reembed when no vectors', () => {
    const result = formatSearchMode(true, 0, 47);
    assert.ok(result.includes('0'), `Should show zero vectors: ${result}`);
  });
});
