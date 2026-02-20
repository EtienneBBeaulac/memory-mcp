// ConfigManager: Handles config hot-reload with stat-based freshness checking
//
// Encapsulates config state (lobeConfigs, configOrigin, stores, lobeHealth, mtime).
// Provides ensureFresh() method that stats the config file and reloads if changed.
// All tool handlers call ensureFresh() at entry to validate config is current.

import { stat } from 'fs/promises';
import type { MemoryConfig } from './types.js';
import { getLobeConfigs, type LoadedConfig, type ConfigOrigin } from './config.js';
import { MarkdownMemoryStore } from './store.js';

/** Health status for a lobe (matches existing LobeHealth in index.ts) */
export type LobeHealth =
  | { readonly status: 'healthy' }
  | { readonly status: 'degraded'; readonly error: string; readonly since: string; readonly recovery: string[] };

/**
 * ConfigManager: Hot-reload config on every tool call.
 *
 * Design:
 * - Constructor takes configPath + initial LoadedConfig from startup
 * - ensureFresh() stats the config file, reloads if mtime changed
 * - Reload is atomic: both lobeConfigs + stores swap together or not at all
 * - Graceful degradation: any error keeps old config, logs to stderr
 * - Observability: all reloads logged with timestamp and lobe count
 */
export class ConfigManager {
  private configPath: string;
  private configOrigin: ConfigOrigin;
  private lobeConfigs: ReadonlyMap<string, MemoryConfig>;
  private stores: Map<string, MarkdownMemoryStore>;
  private lobeHealth: Map<string, LobeHealth>;
  private configMtime: number;

  // Dependency injection for testing: allow tests to override stat function
  protected async statFile(path: string): Promise<{ mtimeMs: number }> {
    return stat(path) as Promise<{ mtimeMs: number }>;
  }

  constructor(configPath: string, initial: LoadedConfig, initialStores: Map<string, MarkdownMemoryStore>, initialHealth: Map<string, LobeHealth>) {
    this.configPath = configPath;
    this.configOrigin = initial.origin;
    this.lobeConfigs = initial.configs;
    this.stores = initialStores;
    this.lobeHealth = initialHealth;
    this.configMtime = Date.now(); // Initial mtime (will be updated on first stat)
  }

  /**
   * Ensure config is fresh. Call at the start of every tool handler.
   * Stats config file, reloads if mtime changed. Graceful on all errors.
   */
  async ensureFresh(): Promise<void> {
    // Only reload file-based configs (env-var configs can't change at runtime)
    if (this.configOrigin.source !== 'file') {
      return;
    }

    try {
      const stats = await this.statFile(this.configPath);
      if (stats.mtimeMs > this.configMtime) {
        await this.reload(stats.mtimeMs);
      }
    } catch (error: unknown) {
      // Any stat error (ENOENT, EACCES, EIO, etc.) → keep old config
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[memory-mcp] Config stat failed: ${message}. Keeping current config.\n`);
    }
  }

  /**
   * Reload config from file. Atomic: both lobeConfigs and stores swap together.
   * Graceful: parse failure or store init failure keeps old config/stores.
   */
  private async reload(newMtime: number): Promise<void> {
    try {
      const newConfig = getLobeConfigs();

      // If parse failed, getLobeConfigs falls through to env/default.
      // For file-based reload, we want to detect parse failure and keep old.
      // Check: if origin changed from 'file' to 'env'/'default', parse failed.
      if (newConfig.origin.source !== 'file') {
        process.stderr.write(`[memory-mcp] Config reload failed (parse error). Keeping current config.\n`);
        return;
      }

      // Initialize new stores
      const newStores = new Map<string, MarkdownMemoryStore>();
      const newHealth = new Map<string, LobeHealth>();

      for (const [name, config] of newConfig.configs) {
        try {
          const store = new MarkdownMemoryStore(config);
          await store.init();
          newStores.set(name, store);
          newHealth.set(name, { status: 'healthy' });
        } catch (error: unknown) {
          // Store init failed → mark as degraded, continue with others
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[memory-mcp] Lobe "${name}" init failed during reload: ${message}. Marked as degraded.\n`);
          newHealth.set(name, {
            status: 'degraded',
            error: message,
            since: new Date().toISOString(),
            recovery: [
              `Verify the repo root exists: ${config.repoRoot}`,
              'Check file permissions on the memory directory.',
              'If the repo was moved, update memory-config.json.',
            ],
          });
        }
      }

      // Atomic swap
      this.configOrigin = newConfig.origin;
      this.lobeConfigs = newConfig.configs;
      this.stores = newStores;
      this.lobeHealth = newHealth;
      this.configMtime = newMtime;

      const lobeCount = newConfig.configs.size;
      const degradedCount = Array.from(newHealth.values()).filter(h => h.status === 'degraded').length;
      const timestamp = new Date().toISOString();
      process.stderr.write(`[memory-mcp] [${timestamp}] Config reloaded: ${lobeCount} lobe(s)${degradedCount > 0 ? `, ${degradedCount} degraded` : ''}\n`);
    } catch (error: unknown) {
      // Reload failed entirely → keep old config
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[memory-mcp] Config reload failed: ${message}. Keeping current config.\n`);
    }
  }

  // Accessors

  getStore(lobe: string): MarkdownMemoryStore | undefined {
    return this.stores.get(lobe);
  }

  getLobeNames(): readonly string[] {
    return Array.from(this.lobeConfigs.keys());
  }

  getLobeHealth(lobe: string): LobeHealth | undefined {
    return this.lobeHealth.get(lobe);
  }

  getConfigOrigin(): ConfigOrigin {
    return this.configOrigin;
  }

  getLobeConfig(lobe: string): MemoryConfig | undefined {
    return this.lobeConfigs.get(lobe);
  }
}
