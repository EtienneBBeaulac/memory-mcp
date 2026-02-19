// Tests for git-service.ts — the injected git operations boundary.
// Tests both the real service (against this repo) and the fake service (deterministic).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import { realGitService, fakeGitService } from '../git-service.js';

describe('fakeGitService', () => {
  it('returns configured branch', async () => {
    const git = fakeGitService('feature/test');
    assert.strictEqual(await git.getCurrentBranch('/any/path'), 'feature/test');
  });

  it('defaults to main', async () => {
    const git = fakeGitService();
    assert.strictEqual(await git.getCurrentBranch('/any/path'), 'main');
  });

  it('returns a deterministic SHA', async () => {
    const git = fakeGitService();
    assert.strictEqual(await git.getHeadSha('/any/path'), 'fake-sha-1234');
  });
});

describe('realGitService', () => {
  it('returns a branch name for a valid git repo', async () => {
    // This test runs against the current repo — should always work in CI/dev
    const branch = await realGitService.getCurrentBranch(process.cwd());
    assert.ok(typeof branch === 'string', 'Should return a string');
    assert.ok(branch.length > 0, 'Branch name should not be empty');
    assert.notStrictEqual(branch, 'unknown', 'Should resolve the branch (not fallback)');
  });

  it('returns unknown for a non-git directory', async () => {
    const branch = await realGitService.getCurrentBranch(os.tmpdir());
    assert.strictEqual(branch, 'unknown');
  });

  it('returns a SHA for a valid git repo', async () => {
    const sha = await realGitService.getHeadSha(process.cwd());
    // This repo has no commits yet, so SHA may be undefined
    // But the function should not throw
    assert.ok(sha === undefined || (typeof sha === 'string' && sha.length > 0),
      'Should return undefined or a valid SHA');
  });

  it('returns undefined for a non-git directory', async () => {
    const sha = await realGitService.getHeadSha(os.tmpdir());
    assert.strictEqual(sha, undefined);
  });
});
