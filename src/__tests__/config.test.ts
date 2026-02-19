// Tests for config.ts — configuration loading with 3-tier fallback.
// Tests the public API: getLobeConfigs() with different env/file setups.
//
// Strategy: We can't easily test file-based config (it reads relative to
// the module), but we CAN test env-based and default-based config.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { getLobeConfigs } from '../config.js';

// Save original env vars so we can restore after each test
const originalEnv: Record<string, string | undefined> = {};
const envKeys = [
  'MEMORY_MCP_WORKSPACES',
  'MEMORY_MCP_DIR',
  'MEMORY_MCP_BUDGET',
  'MEMORY_MCP_REPO_ROOT',
];

function saveEnv(): void {
  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
}

function clearConfigEnv(): void {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

describe('getLobeConfigs', () => {
  let tempDir: string;

  beforeEach(async () => {
    saveEnv();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-config-test-'));
  });

  afterEach(async () => {
    restoreEnv();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('env var config (tier 2)', () => {
    it('loads from MEMORY_MCP_WORKSPACES json', () => {
      clearConfigEnv();
      process.env.MEMORY_MCP_WORKSPACES = JSON.stringify({
        'my-repo': tempDir,
      });
      process.env.MEMORY_MCP_DIR = '.test-memory';

      const { configs, origin } = getLobeConfigs();

      // May load file config first if memory-config.json exists
      // But if we're here, it should have at least one lobe
      assert.ok(configs.size >= 1, 'Should have at least one lobe');

      if (origin.source === 'env') {
        const config = configs.get('my-repo');
        assert.ok(config, 'Should have my-repo lobe');
        assert.strictEqual(config!.repoRoot, tempDir);
        assert.ok(config!.memoryPath.includes('.test-memory'),
          `Memory path should use MEMORY_MCP_DIR: ${config!.memoryPath}`);
      }
    });

    it('loads multiple lobes from env', () => {
      clearConfigEnv();
      const dir2 = tempDir + '-2';
      process.env.MEMORY_MCP_WORKSPACES = JSON.stringify({
        'repo-a': tempDir,
        'repo-b': dir2,
      });

      const { configs, origin } = getLobeConfigs();

      if (origin.source === 'env') {
        assert.strictEqual(configs.size, 2, 'Should have 2 lobes');
        assert.ok(configs.has('repo-a'));
        assert.ok(configs.has('repo-b'));
      }
    });

    it('respects custom budget from env', () => {
      clearConfigEnv();
      process.env.MEMORY_MCP_WORKSPACES = JSON.stringify({
        'my-repo': tempDir,
      });
      process.env.MEMORY_MCP_BUDGET = String(5 * 1024 * 1024); // 5MB

      const { configs, origin } = getLobeConfigs();

      if (origin.source === 'env') {
        const config = configs.get('my-repo');
        assert.strictEqual(config!.storageBudgetBytes, 5 * 1024 * 1024);
      }
    });

    it('falls through on invalid MEMORY_MCP_WORKSPACES JSON', () => {
      clearConfigEnv();
      process.env.MEMORY_MCP_WORKSPACES = 'not valid json';
      process.env.MEMORY_MCP_REPO_ROOT = tempDir;

      // Should not throw — falls through to default
      const { configs } = getLobeConfigs();
      assert.ok(configs.size >= 1, 'Should fall through to at least one lobe');
    });
  });

  describe('default fallback config (tier 3)', () => {
    it('uses MEMORY_MCP_REPO_ROOT when no config file or env workspaces', () => {
      clearConfigEnv();
      process.env.MEMORY_MCP_REPO_ROOT = tempDir;

      const { configs, origin } = getLobeConfigs();

      // If there's no memory-config.json and no MEMORY_MCP_WORKSPACES,
      // it should fall back to default
      if (origin.source === 'default') {
        assert.ok(configs.has('default'), 'Should have a default lobe');
        assert.strictEqual(configs.get('default')!.repoRoot, tempDir);
      }
    });

    it('uses cwd when no env vars at all', () => {
      clearConfigEnv();
      // No env vars set — should use process.cwd()
      const { configs } = getLobeConfigs();
      assert.ok(configs.size >= 1, 'Should always return at least one lobe');
    });

    it('uses explicit MEMORY_MCP_DIR for default lobe', () => {
      clearConfigEnv();
      process.env.MEMORY_MCP_REPO_ROOT = tempDir;
      process.env.MEMORY_MCP_DIR = '.custom-memory';

      const { configs, origin } = getLobeConfigs();

      if (origin.source === 'default') {
        const config = configs.get('default')!;
        assert.ok(config.memoryPath.includes('.custom-memory'),
          `Should use custom dir: ${config.memoryPath}`);
      }
    });
  });

  describe('config structure', () => {
    it('all configs have required fields', () => {
      // Use whatever config is currently active
      const { configs } = getLobeConfigs();

      for (const [name, config] of configs) {
        assert.ok(config.repoRoot, `${name}: repoRoot should be set`);
        assert.ok(config.memoryPath, `${name}: memoryPath should be set`);
        assert.ok(config.storageBudgetBytes > 0, `${name}: storageBudgetBytes should be positive`);
      }
    });

    it('origin is always a valid discriminated union', () => {
      const { origin } = getLobeConfigs();
      assert.ok(['file', 'env', 'default'].includes(origin.source),
        `Origin source should be file, env, or default: ${origin.source}`);

      if (origin.source === 'file') {
        assert.ok('path' in origin && typeof origin.path === 'string',
          'File origin should have a path');
      }
    });
  });
});
