// Git operations boundary — isolates shell/process calls from business logic.
// Inject fakeGitService in tests for determinism; realGitService in production.

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitService } from './types.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;

/** Production git service using real git CLI */
export const realGitService: GitService = {
  async getCurrentBranch(repoRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'git', ['branch', '--show-current'],
        { cwd: repoRoot, timeout: GIT_TIMEOUT_MS },
      );
      const branch = stdout.trim();
      if (branch) return branch;

      // Detached HEAD — use short SHA
      const { stdout: sha } = await execFileAsync(
        'git', ['rev-parse', '--short', 'HEAD'],
        { cwd: repoRoot, timeout: GIT_TIMEOUT_MS },
      );
      return `detached-${sha.trim()}`;
    } catch {
      return 'unknown';
    }
  },

  async getHeadSha(repoRoot: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        'git', ['rev-parse', 'HEAD'],
        { cwd: repoRoot, timeout: GIT_TIMEOUT_MS },
      );
      return stdout.trim();
    } catch {
      return undefined;
    }
  },
};

/** Fake git service for deterministic testing — no shell calls */
export function fakeGitService(branch: string = 'main'): GitService {
  return {
    async getCurrentBranch(): Promise<string> { return branch; },
    async getHeadSha(): Promise<string | undefined> { return 'fake-sha-1234'; },
  };
}
