import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigManager } from '../config-manager.js';
import type { LoadedConfig } from '../config.js';
import type { MemoryConfig } from '../types.js';
import { MarkdownMemoryStore } from '../store.js';

// Test helper: ConfigManager subclass with injectable stat function
class TestableConfigManager extends ConfigManager {
  statImplementation: (path: string) => Promise<{ mtimeMs: number }> = async () => {
    return { mtimeMs: Date.now() - 1000 };
  };

  protected override statFile(path: string): Promise<{ mtimeMs: number }> {
    return this.statImplementation(path);
  }
}

describe('ConfigManager', () => {
  let initialConfig: LoadedConfig;
  let initialStores: Map<string, MarkdownMemoryStore>;
  let initialHealth: Map<string, { status: 'healthy' }>;
  let configPath: string;

  beforeEach(() => {
    configPath = '/fake/memory-config.json';

    // Mock initial config
    const mockConfig: MemoryConfig = {
      repoRoot: '/fake/repo',
      memoryPath: '/fake/memory',
      storageBudgetBytes: 2 * 1024 * 1024,
    };

    initialConfig = {
      configs: new Map([['test-lobe', mockConfig]]),
      origin: { source: 'file', path: configPath },
    };

    // Mock initial stores
    const mockStore = {} as MarkdownMemoryStore;
    initialStores = new Map([['test-lobe', mockStore]]);

    initialHealth = new Map([['test-lobe', { status: 'healthy' }]]);
  });

  describe('ensureFresh', () => {
    it('does not reload when mtime unchanged', async () => {
      const manager = new TestableConfigManager(configPath, initialConfig, initialStores, initialHealth);

      let statCallCount = 0;
      manager.statImplementation = async () => {
        statCallCount++;
        return { mtimeMs: Date.now() - 1000 }; // mtime in the past (no change)
      };

      await manager.ensureFresh();
      await manager.ensureFresh();

      // Stat should be called, but reload should not happen
      assert.equal(statCallCount, 2, 'stat should be called twice');
      assert.equal(manager.getLobeNames().length, 1, 'Should still have 1 lobe');
    });

    it('gracefully handles stat ENOENT error (file deleted)', async () => {
      const manager = new TestableConfigManager(configPath, initialConfig, initialStores, initialHealth);

      manager.statImplementation = async () => {
        const error: any = new Error('ENOENT: no such file');
        error.code = 'ENOENT';
        throw error;
      };

      // Should not throw, should keep old config
      await manager.ensureFresh();
      assert.equal(manager.getLobeNames().length, 1, 'Should keep old config on ENOENT');
    });

    it('gracefully handles stat EACCES error (permission denied)', async () => {
      const manager = new TestableConfigManager(configPath, initialConfig, initialStores, initialHealth);

      manager.statImplementation = async () => {
        const error: any = new Error('EACCES: permission denied');
        error.code = 'EACCES';
        throw error;
      };

      // Should not throw, should keep old config
      await manager.ensureFresh();
      assert.equal(manager.getLobeNames().length, 1, 'Should keep old config on EACCES');
    });

    it('skips reload for env-var-based configs', async () => {
      const envConfig: LoadedConfig = {
        configs: new Map([['test-lobe', initialConfig.configs.get('test-lobe')!]]),
        origin: { source: 'env' },
      };

      let statCalled = false;
      const manager = new TestableConfigManager(configPath, envConfig, initialStores, initialHealth);
      manager.statImplementation = async () => {
        statCalled = true;
        return { mtimeMs: Date.now() };
      };

      await manager.ensureFresh();

      // stat should NOT be called for env-based configs
      assert.equal(statCalled, false, 'Should not stat for env-based configs');
    });

    it('skips reload for default-based configs', async () => {
      const defaultConfig: LoadedConfig = {
        configs: new Map([['default', initialConfig.configs.get('test-lobe')!]]),
        origin: { source: 'default' },
      };

      let statCalled = false;
      const manager = new TestableConfigManager(configPath, defaultConfig, initialStores, initialHealth);
      manager.statImplementation = async () => {
        statCalled = true;
        return { mtimeMs: Date.now() };
      };

      await manager.ensureFresh();

      // stat should NOT be called for default configs
      assert.equal(statCalled, false, 'Should not stat for default configs');
    });
  });

  describe('accessors', () => {
    it('getStore returns store for existing lobe', () => {
      const manager = new ConfigManager(configPath, initialConfig, initialStores, initialHealth);
      const store = manager.getStore('test-lobe');
      assert.ok(store !== undefined, 'Should return store for existing lobe');
    });

    it('getStore returns undefined for non-existent lobe', () => {
      const manager = new ConfigManager(configPath, initialConfig, initialStores, initialHealth);
      const store = manager.getStore('nonexistent');
      assert.equal(store, undefined, 'Should return undefined for missing lobe');
    });

    it('getLobeNames returns array of lobe names', () => {
      const manager = new ConfigManager(configPath, initialConfig, initialStores, initialHealth);
      const names = manager.getLobeNames();
      assert.deepEqual(names, ['test-lobe']);
    });

    it('getConfigOrigin returns current origin', () => {
      const manager = new ConfigManager(configPath, initialConfig, initialStores, initialHealth);
      const origin = manager.getConfigOrigin();
      assert.equal(origin.source, 'file');
      if (origin.source === 'file') {
        assert.equal(origin.path, configPath);
      }
    });

    it('getLobeHealth returns health for existing lobe', () => {
      const manager = new ConfigManager(configPath, initialConfig, initialStores, initialHealth);
      const health = manager.getLobeHealth('test-lobe');
      assert.ok(health !== undefined);
      assert.equal(health.status, 'healthy');
    });

    it('getLobeConfig returns config for existing lobe', () => {
      const manager = new ConfigManager(configPath, initialConfig, initialStores, initialHealth);
      const config = manager.getLobeConfig('test-lobe');
      assert.ok(config !== undefined);
      assert.equal(config.repoRoot, '/fake/repo');
    });
  });
});
