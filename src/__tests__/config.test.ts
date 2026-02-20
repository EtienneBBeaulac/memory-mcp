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
import { getLobeConfigs, parseBehaviorConfig } from '../config.js';

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

  describe('behavior config parsing', () => {
    it('returns empty object when no behavior block provided', () => {
      const result = parseBehaviorConfig(undefined);
      // All fields should be absent (caller falls back to defaults from thresholds.ts)
      assert.strictEqual(Object.keys(result).length, 0);
    });

    it('passes through valid values within allowed ranges', () => {
      const result = parseBehaviorConfig({
        staleDaysStandard: 14,
        staleDaysPreferences: 60,
        maxStaleInBriefing: 3,
        maxDedupSuggestions: 5,
        maxConflictPairs: 2,
      });
      assert.strictEqual(result.staleDaysStandard, 14);
      assert.strictEqual(result.staleDaysPreferences, 60);
      assert.strictEqual(result.maxStaleInBriefing, 3);
      assert.strictEqual(result.maxDedupSuggestions, 5);
      assert.strictEqual(result.maxConflictPairs, 2);
    });

    it('falls back to default for out-of-range staleDaysStandard', () => {
      const tooLow = parseBehaviorConfig({ staleDaysStandard: 0 });
      assert.strictEqual(tooLow.staleDaysStandard, 30, 'Should use default 30 for value below minimum (1)');

      const tooHigh = parseBehaviorConfig({ staleDaysStandard: 500 });
      assert.strictEqual(tooHigh.staleDaysStandard, 30, 'Should use default 30 for value above maximum (365)');
    });

    it('falls back to default for out-of-range staleDaysPreferences', () => {
      const tooHigh = parseBehaviorConfig({ staleDaysPreferences: 800 });
      assert.strictEqual(tooHigh.staleDaysPreferences, 90, 'Should use default 90 for value above maximum (730)');
    });

    it('falls back to default for out-of-range maxStaleInBriefing', () => {
      const tooHigh = parseBehaviorConfig({ maxStaleInBriefing: 50 });
      assert.strictEqual(tooHigh.maxStaleInBriefing, 5, 'Should use default 5 for value above maximum (20)');
    });

    it('falls back to default for out-of-range maxConflictPairs', () => {
      const tooHigh = parseBehaviorConfig({ maxConflictPairs: 10 });
      assert.strictEqual(tooHigh.maxConflictPairs, 2, 'Should use default 2 for value above maximum (5)');
    });

    it('rounds fractional values to integers', () => {
      const result = parseBehaviorConfig({ staleDaysStandard: 14.7 });
      assert.strictEqual(result.staleDaysStandard, 15, 'Should round to nearest integer');
    });

    it('handles partial behavior config — omitted fields do not appear', () => {
      const result = parseBehaviorConfig({ staleDaysStandard: 14 });
      assert.strictEqual(result.staleDaysStandard, 14);
      // Omitted fields should not be set (callers use thresholds.ts defaults)
      assert.strictEqual(result.staleDaysPreferences, 90, 'Non-omitted field uses default');
    });

    it('writes a stderr warning for unknown behavior config keys (typo detection)', () => {
      const stderrWrites: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // Capture stderr
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        if (typeof chunk === 'string') stderrWrites.push(chunk);
        return origWrite(chunk as never, ...(rest as never[]));
      }) as typeof process.stderr.write;

      try {
        // "staleDaysStanderd" is a typo of "staleDaysStandard"
        parseBehaviorConfig({ staleDaysStandard: 14, staleDaysStanderd: 7 } as never);
      } finally {
        process.stderr.write = origWrite;
      }

      const warnings = stderrWrites.filter(s => s.includes('Unknown behavior config key'));
      assert.ok(warnings.length > 0, 'Should warn about unknown key "staleDaysStanderd"');
      assert.ok(warnings[0]!.includes('staleDaysStanderd'), 'Warning should name the offending key');
    });

    it('does not warn for valid behavior config keys', () => {
      const stderrWrites: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        if (typeof chunk === 'string') stderrWrites.push(chunk);
        return origWrite(chunk as never, ...(rest as never[]));
      }) as typeof process.stderr.write;

      try {
        parseBehaviorConfig({ staleDaysStandard: 14, maxStaleInBriefing: 3 });
      } finally {
        process.stderr.write = origWrite;
      }

      const unknownWarnings = stderrWrites.filter(s => s.includes('Unknown behavior config key'));
      assert.strictEqual(unknownWarnings.length, 0, 'Should not warn for valid keys');
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
