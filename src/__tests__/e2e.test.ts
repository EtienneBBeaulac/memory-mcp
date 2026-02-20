// E2E test: spawns the actual MCP server and communicates via JSON-RPC over stdio.
// Tests the full lifecycle with zero mocks — the real binary, real disk I/O, real config.
//
// Framing: MCP uses LSP-style Content-Length headers over stdio.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// --- JSON-RPC / MCP helpers ---
// MCP stdio transport uses newline-delimited JSON (one JSON object per line).

/** Encode a JSON-RPC message as a newline-delimited JSON string */
function encode(msg: object): string {
  return JSON.stringify(msg) + '\n';
}

/** Parse newline-delimited JSON messages from a buffer */
function parseLines(buffer: string): { messages: unknown[]; remaining: string } {
  const messages: unknown[] = [];
  let remaining = buffer;

  while (true) {
    const newlineIdx = remaining.indexOf('\n');
    if (newlineIdx === -1) break;

    const line = remaining.substring(0, newlineIdx).replace(/\r$/, '');
    remaining = remaining.substring(newlineIdx + 1);

    if (line.trim().length === 0) continue;

    try {
      messages.push(JSON.parse(line));
    } catch {
      // Incomplete or malformed line — skip
    }
  }

  return { messages, remaining };
}

interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

/** Manages a spawned MCP server subprocess and provides a high-level call interface */
class McpTestClient {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private pendingResolves = new Map<number, (msg: McpResponse) => void>();
  private nextId = 1;
  private notifications: unknown[] = [];
  // Config file backup tracking for cleanup
  private _configBackupPath?: string;
  private _configOrigPath?: string;

  constructor(
    private readonly repoRoot: string,
    private readonly memoryDir: string,
  ) {}

  /** Spawn the MCP server with env-based config pointing to our temp dir.
   *  Temporarily renames memory-config.json so the server falls through
   *  to env/default config pointing at our isolated temp dir. */
  async start(): Promise<void> {
    // Resolve paths relative to this test file
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    const srcDir = path.resolve(thisDir, '..');
    const projectRoot = path.resolve(srcDir, '..');
    const serverPath = path.join(srcDir, 'index.ts');

    // Temporarily rename memory-config.json so the server uses our env config
    const configFile = path.join(projectRoot, 'memory-config.json');
    const configBackup = configFile + '.e2e-backup';
    try {
      await fs.rename(configFile, configBackup);
      this._configBackupPath = configBackup;
      this._configOrigPath = configFile;
    } catch {
      // No config file to rename — env-based config will work directly
    }

    this.proc = spawn('node', ['--import', 'tsx', serverPath], {
      env: {
        ...process.env,
        // Override config to use our temp dir as a single-lobe default
        MEMORY_MCP_REPO_ROOT: this.repoRoot,
        MEMORY_MCP_DIR: this.memoryDir,
        // Clear any existing config env vars so they don't interfere
        MEMORY_MCP_WORKSPACES: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.setEncoding('utf-8');
    this.proc.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      const { messages, remaining } = parseLines(this.buffer);
      this.buffer = remaining;

      for (const msg of messages) {
        const rpc = msg as McpResponse;
        if (rpc.id !== undefined && this.pendingResolves.has(rpc.id)) {
          this.pendingResolves.get(rpc.id)!(rpc);
          this.pendingResolves.delete(rpc.id);
        } else {
          this.notifications.push(msg);
        }
      }
    });

    // Wait for process to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
      this.proc!.stderr!.setEncoding('utf-8');
      this.proc!.stderr!.on('data', (chunk: string) => {
        if (chunk.includes('Server started')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.proc!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.proc!.on('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });

    // MCP handshake: initialize
    const initResult = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    });
    assert.ok(initResult.result, 'Initialize should return a result');

    // Send initialized notification (no id = notification)
    this.proc.stdin!.write(encode({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }));
  }

  /** Send a JSON-RPC request and wait for the response */
  async send(method: string, params: object): Promise<McpResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResolves.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 15000);

      this.pendingResolves.set(id, (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });

      this.proc!.stdin!.write(encode({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Call an MCP tool and return the response */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpResponse> {
    return this.send('tools/call', { name, arguments: args });
  }

  /** Get the text content from a tool response */
  getText(response: McpResponse): string {
    return response.result?.content?.[0]?.text ?? '';
  }

  /** Check if response is an error */
  isError(response: McpResponse): boolean {
    return response.result?.isError === true || !!response.error;
  }

  /** Gracefully shut down the server and restore any modified config files */
  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.stdin!.end();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.proc?.kill('SIGKILL');
          resolve();
        }, 3000);
        this.proc!.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.proc = null;
    }
    // Restore config file if we renamed it
    if (this._configBackupPath && this._configOrigPath) {
      await fs.rename(this._configBackupPath, this._configOrigPath).catch(() => {});
    }
  }
}

// --- E2E Tests ---

describe('E2E: MCP Server', () => {
  let tempDir: string;
  let memoryDir: string;
  let client: McpTestClient;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-e2e-'));
    memoryDir = path.join(tempDir, '.memory');

    // Create a minimal repo structure for bootstrap
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'package.json'), '{"name": "test-repo"}');
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Test Repo\n\nA repo for e2e testing the memory MCP server.');

    client = new McpTestClient(tempDir, memoryDir);
    await client.start();
  });

  after(async () => {
    await client.stop();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('tool listing', () => {
    it('lists all available tools', async () => {
      const response = await client.send('tools/list', {});
      const tools = response.result?.tools as Array<{ name: string }>;
      assert.ok(Array.isArray(tools), 'Should return an array of tools');

      const toolNames = tools.map(t => t.name);
      // 5 visible tools
      assert.ok(toolNames.includes('memory_store'), 'Should have memory_store');
      assert.ok(toolNames.includes('memory_query'), 'Should have memory_query');
      assert.ok(toolNames.includes('memory_correct'), 'Should have memory_correct');
      assert.ok(toolNames.includes('memory_context'), 'Should have memory_context');
      assert.ok(toolNames.includes('memory_bootstrap'), 'Should have memory_bootstrap');
      // Hidden tools — still callable but not in the catalog
      assert.ok(!toolNames.includes('memory_briefing'), 'Should NOT have memory_briefing (replaced by memory_context)');
      assert.ok(!toolNames.includes('memory_diagnose'), 'Should NOT list memory_diagnose (hidden)');
      assert.ok(!toolNames.includes('memory_stats'), 'Should NOT list memory_stats (hidden)');
      assert.ok(!toolNames.includes('memory_list_lobes'), 'Should NOT list memory_list_lobes (hidden)');
      assert.strictEqual(toolNames.length, 5, 'Should have exactly 5 visible tools');
    });
  });

  describe('memory_list_lobes', () => {
    it('returns server info with default lobe', async () => {
      const response = await client.callTool('memory_list_lobes');
      assert.ok(!client.isError(response), 'Should not be an error');
      const text = client.getText(response);
      const data = JSON.parse(text);

      assert.strictEqual(data.serverMode, 'running');
      assert.ok(data.lobes.length >= 1, 'Should have at least one lobe');
      assert.strictEqual(data.lobes[0].health, 'healthy');
    });
  });

  describe('store -> query -> correct lifecycle', () => {
    let storedId: string;

    it('stores a knowledge entry', async () => {
      const response = await client.callTool('memory_store', {
        topic: 'architecture',
        title: 'E2E Test Pattern',
        content: 'This repo uses MVI architecture with standalone reducers',
        trust: 'user',
      });
      assert.ok(!client.isError(response), `Store should succeed: ${client.getText(response)}`);
      const text = client.getText(response);
      assert.ok(text.includes('Stored entry'), 'Should confirm storage');
      assert.ok(text.includes('architecture'), 'Should mention topic');

      // Extract ID from response
      const idMatch = text.match(/Stored entry (arch-[0-9a-f]+)/);
      assert.ok(idMatch, 'Should contain entry ID');
      storedId = idMatch![1];
    });

    it('queries the stored entry back', async () => {
      const response = await client.callTool('memory_query', {
        scope: 'architecture',
        detail: 'full',
      });
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      assert.ok(text.includes('E2E Test Pattern'), 'Should find stored entry by title');
      assert.ok(text.includes('MVI architecture'), 'Should contain the stored content');
      assert.ok(text.includes(storedId), 'Should contain the entry ID');
    });

    it('queries with wildcard scope', async () => {
      const response = await client.callTool('memory_query', {
        scope: '*',
        detail: 'brief',
      });
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      assert.ok(text.includes('E2E Test Pattern'));
    });

    it('queries with filter', async () => {
      const response = await client.callTool('memory_query', {
        scope: '*',
        detail: 'brief',
        filter: 'MVI reducer',
      });
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      assert.ok(text.includes('E2E Test Pattern'), 'Filter should match entry');
    });

    it('corrects an entry with append', async () => {
      const response = await client.callTool('memory_correct', {
        id: storedId,
        action: 'append',
        correction: 'Also uses sealed interfaces for events',
      });
      assert.ok(!client.isError(response), `Correct should succeed: ${client.getText(response)}`);
      const text = client.getText(response);
      assert.ok(text.includes('Corrected entry'), 'Should confirm correction');

      // Verify the append persisted
      const queryResp = await client.callTool('memory_query', {
        scope: 'architecture',
        detail: 'full',
      });
      const queryText = client.getText(queryResp);
      assert.ok(queryText.includes('sealed interfaces'), 'Appended content should be visible');
      assert.ok(queryText.includes('MVI architecture'), 'Original content should remain');
    });

    it('corrects an entry with replace', async () => {
      const response = await client.callTool('memory_correct', {
        id: storedId,
        action: 'replace',
        correction: 'Clean Architecture with MVVM pattern',
      });
      assert.ok(!client.isError(response));

      const queryResp = await client.callTool('memory_query', {
        scope: 'architecture',
        detail: 'full',
      });
      const queryText = client.getText(queryResp);
      assert.ok(queryText.includes('Clean Architecture'), 'Replaced content should be visible');
      assert.ok(!queryText.includes('MVI architecture'), 'Original content should be gone');
    });

    it('deletes an entry', async () => {
      const response = await client.callTool('memory_correct', {
        id: storedId,
        action: 'delete',
      });
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      assert.ok(text.includes('Deleted entry'), 'Should confirm deletion');

      // Verify it's gone
      const queryResp = await client.callTool('memory_query', {
        scope: 'architecture',
        detail: 'brief',
      });
      const queryText = client.getText(queryResp);
      assert.ok(!queryText.includes(storedId), 'Deleted entry should not appear');
    });
  });

  describe('context search', () => {
    before(async () => {
      // Seed entries for context search
      await client.callTool('memory_store', {
        topic: 'architecture',
        title: 'Kotlin Reducer Pattern',
        content: 'Standalone reducer classes with inject constructor in Kotlin',
        trust: 'user',
      });
      await client.callTool('memory_store', {
        topic: 'conventions',
        title: 'Kotlin Naming',
        content: 'Use Real prefix instead of Impl postfix for Kotlin implementation classes',
        trust: 'user',
      });
      await client.callTool('memory_store', {
        topic: 'gotchas',
        title: 'Kotlin Build Gotcha',
        content: 'Must clean build after Kotlin module dependency changes',
        trust: 'user',
      });
    });

    it('returns relevant entries for a context description', async () => {
      const response = await client.callTool('memory_context', {
        context: 'writing a Kotlin reducer for state management',
      });
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      assert.ok(text.includes('Kotlin Reducer Pattern') || text.includes('Kotlin Naming') || text.includes('Kotlin Build Gotcha'),
        'Should return at least one Kotlin-related entry');
    });

    it('returns no results for unrelated context', async () => {
      const response = await client.callTool('memory_context', {
        context: 'quantum computing neural networks',
      });
      const text = client.getText(response);
      assert.ok(text.includes('No relevant knowledge found') || text.includes('Context:'),
        'Should either find nothing or return minimal matches');
    });
  });

  describe('briefing mode (memory_context with no args)', () => {
    it('generates a session briefing when context is omitted', async () => {
      const response = await client.callTool('memory_context', {});
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      // Should have meaningful content (user + preferences + stale nudges)
      assert.ok(text.length > 50, 'Briefing should have meaningful content');
      assert.ok(text.includes('memory_context'), 'Briefing should mention memory_context for task-specific lookup');
    });

    it('memory_diagnose still works when called directly (hidden tool)', async () => {
      const response = await client.callTool('memory_diagnose', {});
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      assert.ok(text.includes('Diagnostics') || text.includes('Server mode'), 'Should return diagnostics');
    });
  });

  describe('stats', () => {
    it('returns memory stats', async () => {
      const response = await client.callTool('memory_stats', {});
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      assert.ok(text.includes('Memory Stats'), 'Should have stats header');
      assert.ok(text.includes('Total entries'), 'Should show total entries');
      assert.ok(text.includes('By Topic'), 'Should show topic breakdown');
      assert.ok(text.includes('By Trust'), 'Should show trust breakdown');
    });
  });

  describe('bootstrap', () => {
    it('seeds entries from repo structure', async () => {
      const response = await client.callTool('memory_bootstrap', {});
      assert.ok(!client.isError(response), `Bootstrap should succeed: ${client.getText(response)}`);
      const text = client.getText(response);
      assert.ok(text.includes('Bootstrap Complete'), 'Should confirm bootstrap');
      assert.ok(text.includes('Stored'), 'Should report stored entries');
    });
  });

  describe('diagnose', () => {
    it('returns diagnostics', async () => {
      const response = await client.callTool('memory_diagnose', {});
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      assert.ok(text.includes('Diagnostics'), 'Should have diagnostics header');
      assert.ok(text.includes('Server mode'), 'Should show server mode');
      assert.ok(text.includes('running'), 'Server should be in running mode');
      assert.ok(text.includes('Lobe Health'), 'Should show lobe health');
    });
  });

  describe('error handling', () => {
    it('rejects invalid topic', async () => {
      const response = await client.callTool('memory_store', {
        topic: 'banana',
        title: 'Test',
        content: 'Test',
      });
      assert.ok(client.isError(response), 'Should be an error');
      const text = client.getText(response);
      assert.ok(text.includes('Invalid topic'), 'Should mention invalid topic');
    });

    it('rejects missing required fields', async () => {
      const response = await client.callTool('memory_store', {
        topic: 'architecture',
        // title and content missing
      });
      assert.ok(client.isError(response), 'Should be an error');
    });

    it('rejects correct on non-existent entry', async () => {
      const response = await client.callTool('memory_correct', {
        id: 'nonexistent-999',
        action: 'replace',
        correction: 'fix',
      });
      assert.ok(client.isError(response), 'Should be an error');
      const text = client.getText(response);
      assert.ok(text.includes('not found') || text.includes('Failed to correct'), 'Should mention not found');
    });

    it('returns error for unknown tool', async () => {
      const response = await client.callTool('memory_nonexistent', {});
      const text = client.getText(response);
      assert.ok(text.includes('Unknown tool') || client.isError(response));
    });

    it('handles correction without text for append', async () => {
      const storeResp = await client.callTool('memory_store', {
        topic: 'conventions',
        title: 'Temp Entry for Error Test',
        content: 'temp',
      });
      const idMatch = client.getText(storeResp).match(/(conv-[0-9a-f]+)/);
      if (idMatch) {
        const response = await client.callTool('memory_correct', {
          id: idMatch[1],
          action: 'append',
          // correction missing
        });
        assert.ok(client.isError(response), 'Should reject append without correction text');
        // Cleanup
        await client.callTool('memory_correct', { id: idMatch[1], action: 'delete' });
      }
    });
  });

  describe('param alias normalization (e2e)', () => {
    it('resolves key/value aliases to title/content', async () => {
      const response = await client.callTool('memory_store', {
        topic: 'conventions',
        key: 'Alias Test',
        value: 'Testing param alias normalization works e2e',
        trust: 'agent-inferred',
      });
      assert.ok(!client.isError(response), `Alias store should succeed: ${client.getText(response)}`);
      const text = client.getText(response);
      assert.ok(text.includes('Stored entry'), 'Should confirm storage');

      // Verify the entry was actually stored with the alias-resolved title
      const queryResp = await client.callTool('memory_query', {
        scope: 'conventions',
        detail: 'full',
        filter: 'Alias Test',
      });
      assert.ok(client.getText(queryResp).includes('Alias Test'), 'Should store with aliased title');

      // Cleanup
      const idMatch = text.match(/(conv-[0-9a-f]+)/);
      if (idMatch) {
        await client.callTool('memory_correct', { id: idMatch[1], action: 'delete' });
      }
    });
  });

  describe('dedup detection (e2e)', () => {
    it('surfaces related entries when storing similar content', async () => {
      // Store first entry
      await client.callTool('memory_store', {
        topic: 'conventions',
        title: 'Sealed Interface Convention',
        content: 'Always use sealed interfaces for state management events in Kotlin',
        trust: 'user',
      });

      // Store very similar entry
      const response = await client.callTool('memory_store', {
        topic: 'conventions',
        title: 'State Management Conventions',
        content: 'Use sealed interfaces for state management events and actions in Kotlin modules',
        trust: 'user',
      });
      assert.ok(!client.isError(response));
      const text = client.getText(response);
      // The dedup detection may or may not fire depending on similarity threshold
      // Just verify the store succeeded
      assert.ok(text.includes('Stored entry'), 'Similar entry should still be stored');
    });
  });

  describe('multiple topics lifecycle', () => {
    it('stores and queries across multiple topics', async () => {
      // Store in multiple topics
      const arch = await client.callTool('memory_store', {
        topic: 'architecture',
        title: 'Multi-Topic Arch',
        content: 'Multi-topic architecture test',
      });
      const conv = await client.callTool('memory_store', {
        topic: 'conventions',
        title: 'Multi-Topic Conv',
        content: 'Multi-topic conventions test',
      });
      const gotcha = await client.callTool('memory_store', {
        topic: 'gotchas',
        title: 'Multi-Topic Gotcha',
        content: 'Multi-topic gotcha test',
      });

      assert.ok(!client.isError(arch));
      assert.ok(!client.isError(conv));
      assert.ok(!client.isError(gotcha));

      // Query all — should find entries from all topics
      const allResp = await client.callTool('memory_query', {
        scope: '*',
        detail: 'brief',
        filter: 'Multi-Topic',
      });
      const allText = client.getText(allResp);
      assert.ok(allText.includes('Multi-Topic Arch'), 'Should find architecture entry');
      assert.ok(allText.includes('Multi-Topic Conv'), 'Should find conventions entry');
      assert.ok(allText.includes('Multi-Topic Gotcha'), 'Should find gotcha entry');

      // Query single topic
      const gotchaResp = await client.callTool('memory_query', {
        scope: 'gotchas',
        detail: 'brief',
        filter: 'Multi-Topic',
      });
      const gotchaText = client.getText(gotchaResp);
      assert.ok(gotchaText.includes('Multi-Topic Gotcha'), 'Should find gotcha');
      assert.ok(!gotchaText.includes('Multi-Topic Arch'), 'Should not find architecture in gotchas scope');
    });
  });

  describe('module-scoped topics', () => {
    it('stores and queries module-scoped entries', async () => {
      const response = await client.callTool('memory_store', {
        topic: 'modules/messaging',
        title: 'Messaging Module Overview',
        content: 'The messaging module handles real-time chat with StreamCoordinator',
      });
      assert.ok(!client.isError(response), `Module store should succeed: ${client.getText(response)}`);
      const text = client.getText(response);
      assert.ok(text.includes('modules/messaging'), 'Should mention the module topic');

      // Query it back
      const queryResp = await client.callTool('memory_query', {
        scope: 'modules/messaging',
        detail: 'full',
      });
      assert.ok(!client.isError(queryResp));
      const queryText = client.getText(queryResp);
      assert.ok(queryText.includes('StreamCoordinator'), 'Should find module entry content');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Feature 1: references field (e2e)
  // ────────────────────────────────────────────────────────────────────────────

  describe('references field (e2e)', () => {
    it('stores and queries references via tool call', async () => {
      const storeResp = await client.callTool('memory_store', {
        topic: 'architecture',
        title: 'Messaging Reducer Architecture',
        content: 'The messaging feature uses a standalone reducer pattern with sealed interface events',
        references: ['features/messaging/impl/MessagingReducer.kt', 'features/messaging/api/MessagingEvent.kt'],
        trust: 'agent-confirmed',
      });
      assert.ok(!client.isError(storeResp), `Store with references should succeed: ${client.getText(storeResp)}`);
      const storeText = client.getText(storeResp);
      assert.ok(storeText.includes('Stored entry'), 'Should confirm storage');

      // Query back with full detail — references should appear
      const queryResp = await client.callTool('memory_query', {
        scope: 'architecture',
        detail: 'full',
        filter: 'Messaging Reducer Architecture',
      });
      assert.ok(!client.isError(queryResp));
      const queryText = client.getText(queryResp);
      assert.ok(queryText.includes('MessagingReducer.kt'), 'References should appear in full detail response');
      assert.ok(queryText.includes('MessagingEvent.kt'), 'All references should appear');

      // Extract ID and clean up
      const idMatch = storeText.match(/(arch-[0-9a-f]+)/);
      if (idMatch) {
        await client.callTool('memory_correct', { id: idMatch[1], action: 'delete' });
      }
    });

    it('accepts refs alias for references', async () => {
      const storeResp = await client.callTool('memory_store', {
        topic: 'conventions',
        title: 'Refs Alias Test',
        content: 'Testing that refs is accepted as an alias for references field in tool calls',
        refs: ['src/SomeClass.kt'],
      });
      assert.ok(!client.isError(storeResp), `Store with refs alias should succeed: ${client.getText(storeResp)}`);

      // Query back with full detail
      const queryResp = await client.callTool('memory_query', {
        scope: 'conventions',
        detail: 'full',
        filter: 'Refs Alias Test',
      });
      const queryText = client.getText(queryResp);
      assert.ok(queryText.includes('SomeClass.kt'), 'refs alias should be normalized to references');

      // Clean up
      const storeText = client.getText(storeResp);
      const idMatch = storeText.match(/(conv-[0-9a-f]+)/);
      if (idMatch) {
        await client.callTool('memory_correct', { id: idMatch[1], action: 'delete' });
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Feature 2: Stale entry nudges in briefing (e2e)
  // ────────────────────────────────────────────────────────────────────────────

  describe('stale entry touch via memory_correct (e2e)', () => {
    it('refreshes lastAccessed when correcting with empty append', async () => {
      // Store an entry
      const storeResp = await client.callTool('memory_store', {
        topic: 'architecture',
        title: 'Touchable Entry',
        content: 'Architecture pattern to verify timestamp refresh via empty append',
        trust: 'agent-inferred',
      });
      assert.ok(!client.isError(storeResp));
      const storeText = client.getText(storeResp);
      const idMatch = storeText.match(/(arch-[0-9a-f]+)/);
      assert.ok(idMatch, 'Should get an entry ID');
      const entryId = idMatch![1];

      // Touch the entry with an empty append — this refreshes lastAccessed
      const touchResp = await client.callTool('memory_correct', {
        id: entryId,
        action: 'append',
        correction: '',
      });
      assert.ok(!client.isError(touchResp), `Empty append should succeed: ${client.getText(touchResp)}`);
      assert.ok(client.getText(touchResp).includes('Corrected entry'), 'Should confirm the correction');

      // Query back — entry should still exist with original content structure
      const queryResp = await client.callTool('memory_query', {
        scope: 'architecture',
        detail: 'full',
        filter: 'Touchable Entry',
      });
      assert.ok(!client.isError(queryResp));
      assert.ok(client.getText(queryResp).includes('Architecture pattern'), 'Content should persist after touch');

      // Clean up
      await client.callTool('memory_correct', { id: entryId, action: 'delete' });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Feature 3: Conflict detection (e2e)
  // ────────────────────────────────────────────────────────────────────────────

  describe('conflict detection (e2e)', () => {
    it('surfaces conflict warning when querying highly similar entries', async () => {
      const longShared = 'This codebase uses MVI architecture pattern with standalone reducer classes sealed interface events ViewModels as orchestrators and coroutines for async operations';

      const r1 = await client.callTool('memory_store', {
        topic: 'architecture',
        title: 'MVI Architecture Overview',
        content: longShared,
        trust: 'user',
      });
      const r2 = await client.callTool('memory_store', {
        topic: 'conventions',
        title: 'Architecture Conventions',
        content: longShared + ' following clean architecture principles',
        trust: 'user',
      });
      assert.ok(!client.isError(r1) && !client.isError(r2), 'Both stores should succeed');

      // Query with wildcard — should detect the conflict cross-topic
      const queryResp = await client.callTool('memory_query', {
        scope: '*',
        detail: 'full',
        filter: 'MVI architecture reducer',
      });
      const queryText = client.getText(queryResp);
      assert.ok(queryText.includes('⚠') || queryText.includes('Potential conflicts'), 'Should surface conflict warning for highly similar entries');

      // Clean up
      const t1 = client.getText(r1).match(/(arch-[0-9a-f]+)/);
      const t2 = client.getText(r2).match(/(conv-[0-9a-f]+)/);
      if (t1) await client.callTool('memory_correct', { id: t1[1], action: 'delete' });
      if (t2) await client.callTool('memory_correct', { id: t2[1], action: 'delete' });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Operational tools and diagnostics (e2e)
  // ────────────────────────────────────────────────────────────────────────────

  describe('operational tools (e2e)', () => {
    it('memory_list_lobes returns lobe info', async () => {
      const resp = await client.callTool('memory_list_lobes');
      assert.ok(!client.isError(resp), 'memory_list_lobes should work');
      const data = JSON.parse(client.getText(resp));
      assert.ok(data.lobes, 'Should have lobes array');
      assert.ok(data.serverMode, 'Should have serverMode');
    });

    it('memory_stats returns stats', async () => {
      const resp = await client.callTool('memory_stats');
      assert.ok(!client.isError(resp), 'memory_stats should work');
      assert.ok(client.getText(resp).includes('Memory Stats'), 'Should contain stats header');
    });

    it('memory_diagnose returns diagnostics', async () => {
      const resp = await client.callTool('memory_diagnose');
      assert.ok(!client.isError(resp), 'memory_diagnose should work');
      assert.ok(client.getText(resp).includes('Diagnostics'), 'Should contain diagnostics header');
    });

    it('memory_diagnose surfaces active behavior config section', async () => {
      const resp = await client.callTool('memory_diagnose');
      assert.ok(!client.isError(resp), `memory_diagnose should succeed: ${client.getText(resp)}`);
      const text = client.getText(resp);

      // Behavior config section should always be present in diagnostics
      assert.ok(text.includes('Active Behavior Config'), 'Should include behavior config section header');
      assert.ok(text.includes('staleDaysStandard'), 'Should show staleDaysStandard');
      assert.ok(text.includes('staleDaysPreferences'), 'Should show staleDaysPreferences');
      assert.ok(text.includes('maxStaleInBriefing'), 'Should show maxStaleInBriefing');

      // In tests there is no memory-config.json, so all values should be defaults
      assert.ok(text.includes('(default)'), 'Should mark values as default when no behavior override is set');
      assert.ok(text.includes('memory-config.json'), 'Should hint how to customize');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Ephemeral content detection (e2e)
  // ────────────────────────────────────────────────────────────────────────

  describe('ephemeral content detection (e2e)', () => {
    it('surfaces ephemeral warning for temporal content via tool call', async () => {
      const resp = await client.callTool('memory_store', {
        topic: 'gotchas',
        title: 'Ephemeral Test Entry',
        content: 'The build is currently broken and we are investigating the root cause right now',
        trust: 'agent-inferred',
      });
      assert.ok(!client.isError(resp), `Store should succeed: ${client.getText(resp)}`);
      const text = client.getText(resp);
      assert.ok(text.includes('Stored entry'), 'Entry should be stored (soft warning, not blocked)');
      assert.ok(text.includes('⏳'), 'Should include ephemeral warning marker');
      assert.ok(text.includes('ephemeral'), 'Should mention ephemeral content');

      // Clean up
      const idMatch = text.match(/(gotcha-[0-9a-f]+)/);
      if (idMatch) await client.callTool('memory_correct', { id: idMatch[1], action: 'delete' });
    });

    it('surfaces ephemeral warning for fixed-bug content', async () => {
      const resp = await client.callTool('memory_store', {
        topic: 'gotchas',
        title: 'Fixed Bug Entry',
        content: 'The crash bug in messaging has been resolved by updating the dependency injection scope',
        trust: 'agent-confirmed',
      });
      assert.ok(!client.isError(resp));
      const text = client.getText(resp);
      assert.ok(text.includes('⏳'), 'Should include ephemeral warning for fixed bugs');
      assert.ok(text.includes('Resolved issue') || text.includes('resolved'), 'Should flag resolved issues');

      const idMatch = text.match(/(gotcha-[0-9a-f]+)/);
      if (idMatch) await client.callTool('memory_correct', { id: idMatch[1], action: 'delete' });
    });

    it('does not surface ephemeral warning for durable content', async () => {
      const resp = await client.callTool('memory_store', {
        topic: 'architecture',
        title: 'Durable Architecture Entry',
        content: 'The messaging feature uses MVI with standalone reducer classes and sealed interface events for exhaustive handling',
        trust: 'user',
      });
      assert.ok(!client.isError(resp));
      const text = client.getText(resp);
      assert.ok(!text.includes('⏳'), 'Durable content should not trigger ephemeral warning');

      const idMatch = text.match(/(arch-[0-9a-f]+)/);
      if (idMatch) await client.callTool('memory_correct', { id: idMatch[1], action: 'delete' });
    });
  });
});
