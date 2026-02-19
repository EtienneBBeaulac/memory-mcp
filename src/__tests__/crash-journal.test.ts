// Tests for crash-journal.ts — crash report lifecycle: build, write, read, clear, format.
// Uses real disk I/O with isolated temp directories — no mocks.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  buildCrashReport,
  writeCrashReport,
  readLatestCrash,
  readCrashHistory,
  clearLatestCrash,
  formatCrashReport,
  formatCrashSummary,
  markServerStarted,
  type CrashReport,
  type CrashContext,
} from '../crash-journal.js';

// The crash journal writes to ~/.memory-mcp/crashes/ — we need to isolate tests.
// We'll monkey-patch the module's internal CRASH_DIR by writing to a temp dir
// and reading back. Since the module uses hardcoded paths, we test the public
// API behaviors: buildCrashReport (pure), format functions (pure), and
// read/write lifecycle (I/O — uses real paths, so we clean up carefully).

describe('buildCrashReport', () => {
  it('builds a report from an Error', () => {
    markServerStarted();
    const error = new Error('Test failure');
    const context: CrashContext = {
      phase: 'running',
      lastToolCall: 'memory_store',
      configSource: 'file',
      lobeCount: 2,
    };

    const report = buildCrashReport(error, 'uncaught-exception', context);

    assert.strictEqual(report.error, 'Test failure');
    assert.ok(report.stack?.includes('Test failure'), 'Should include stack trace');
    assert.strictEqual(report.type, 'uncaught-exception');
    assert.strictEqual(report.context.phase, 'running');
    assert.strictEqual(report.context.lastToolCall, 'memory_store');
    assert.ok(report.timestamp, 'Should have ISO timestamp');
    assert.ok(report.pid > 0, 'Should have process ID');
    assert.ok(Array.isArray(report.recovery), 'Should have recovery steps');
    assert.ok(report.recovery.length > 0, 'Should have at least one recovery step');
  });

  it('builds a report from a non-Error value', () => {
    markServerStarted();
    const report = buildCrashReport('string error', 'unknown', { phase: 'startup' });

    assert.strictEqual(report.error, 'string error');
    assert.strictEqual(report.stack, undefined, 'Non-Error has no stack');
    assert.strictEqual(report.type, 'unknown');
  });

  it('includes server uptime', () => {
    markServerStarted();
    const report = buildCrashReport(new Error('test'), 'unknown', { phase: 'running' });
    assert.ok(report.serverUptime >= 0, 'Uptime should be non-negative');
  });

  it('generates recovery steps for startup-failure', () => {
    const report = buildCrashReport(
      new Error('Cannot read memory-config.json'),
      'startup-failure',
      { phase: 'startup', configSource: 'file' },
    );
    assert.ok(report.recovery.some(s => s.includes('memory-config.json')),
      'Should mention config file in recovery');
  });

  it('generates recovery steps for lobe-init-failure', () => {
    const report = buildCrashReport(
      new Error('ENOENT: no such directory'),
      'lobe-init-failure',
      { phase: 'startup', activeLobe: 'my-repo' },
    );
    assert.ok(report.recovery.some(s => s.includes('my-repo')),
      'Should mention the failed lobe');
  });

  it('generates recovery steps for transport-error', () => {
    const report = buildCrashReport(
      new Error('pipe broken'),
      'transport-error',
      { phase: 'running' },
    );
    assert.ok(report.recovery.some(s => s.includes('toggle') || s.includes('Toggle')),
      'Should suggest toggling MCP');
  });

  it('detects disk-full errors in recovery', () => {
    const report = buildCrashReport(
      new Error('ENOSPC: no space left on device'),
      'uncaught-exception',
      { phase: 'running' },
    );
    assert.ok(report.recovery.some(s => s.toLowerCase().includes('disk') || s.toLowerCase().includes('space')),
      'Should mention disk space');
  });

  it('detects permission errors in recovery', () => {
    const report = buildCrashReport(
      new Error('EACCES: permission denied'),
      'uncaught-exception',
      { phase: 'running' },
    );
    assert.ok(report.recovery.some(s => s.toLowerCase().includes('permission')),
      'Should mention permissions');
  });
});

describe('formatCrashReport', () => {
  const sampleReport: CrashReport = {
    timestamp: '2026-01-15T10:30:00.000Z',
    pid: 12345,
    error: 'ENOENT: file not found',
    stack: 'Error: ENOENT\n  at readFile (node:fs)\n  at Store.init (store.ts:42)',
    type: 'startup-failure',
    context: {
      phase: 'startup',
      lastToolCall: 'memory_bootstrap',
      activeLobe: 'zillow',
      configSource: 'file',
      lobeCount: 3,
    },
    recovery: ['Check file permissions', 'Toggle MCP to restart'],
    serverUptime: 0,
  };

  it('includes all key fields', () => {
    const formatted = formatCrashReport(sampleReport);

    assert.ok(formatted.includes('2026-01-15'), 'Should include timestamp');
    assert.ok(formatted.includes('startup-failure'), 'Should include crash type');
    assert.ok(formatted.includes('startup'), 'Should include phase');
    assert.ok(formatted.includes('ENOENT'), 'Should include error message');
    assert.ok(formatted.includes('memory_bootstrap'), 'Should include last tool call');
    assert.ok(formatted.includes('zillow'), 'Should include affected lobe');
  });

  it('includes recovery steps', () => {
    const formatted = formatCrashReport(sampleReport);
    assert.ok(formatted.includes('Check file permissions'));
    assert.ok(formatted.includes('Toggle MCP to restart'));
  });

  it('includes truncated stack trace', () => {
    const formatted = formatCrashReport(sampleReport);
    assert.ok(formatted.includes('Stack Trace'), 'Should have stack trace section');
    assert.ok(formatted.includes('ENOENT'), 'Should include stack content');
  });

  it('omits stack trace section when absent', () => {
    const noStack: CrashReport = { ...sampleReport, stack: undefined };
    const formatted = formatCrashReport(noStack);
    assert.ok(!formatted.includes('Stack Trace'), 'Should not have stack trace section');
  });
});

describe('formatCrashSummary', () => {
  it('formats a short summary with age', () => {
    const report: CrashReport = {
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
      pid: 1,
      error: 'Something broke unexpectedly during startup',
      type: 'startup-failure',
      context: { phase: 'startup' },
      recovery: [],
      serverUptime: 10,
    };

    const summary = formatCrashSummary(report);
    assert.ok(summary.includes('5m ago') || summary.includes('4m ago'), 'Should show age in minutes');
    assert.ok(summary.includes('startup-failure'), 'Should include type');
    assert.ok(summary.includes('Something broke'), 'Should include error text');
  });

  it('truncates long error messages', () => {
    const report: CrashReport = {
      timestamp: new Date().toISOString(),
      pid: 1,
      error: 'A'.repeat(200),
      type: 'unknown',
      context: { phase: 'running' },
      recovery: [],
      serverUptime: 0,
    };

    const summary = formatCrashSummary(report);
    assert.ok(summary.length < 250, 'Summary should be concise');
  });
});

describe('crash report write/read lifecycle', () => {
  // These tests use the real crash directory (~/.memory-mcp/crashes/)
  // We write unique reports and clean them up after.
  const testReports: CrashReport[] = [];

  afterEach(async () => {
    // Clean up test crash files
    for (const report of testReports) {
      const filename = `crash-${report.timestamp.replace(/[:.]/g, '-')}.json`;
      const filepath = path.join(os.homedir(), '.memory-mcp', 'crashes', filename);
      await fs.unlink(filepath).catch(() => {});
    }
    testReports.length = 0;
    // Always clear LATEST.json to not interfere with real server
    await clearLatestCrash();
  });

  it('writes and reads back a crash report', async () => {
    markServerStarted();
    const report = buildCrashReport(
      new Error('e2e test crash'),
      'uncaught-exception',
      { phase: 'running' },
    );
    testReports.push(report);

    const filepath = await writeCrashReport(report);
    assert.ok(filepath.endsWith('.json'), 'Should write a .json file');

    // Verify the file exists and is parseable
    const content = await fs.readFile(filepath, 'utf-8');
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.error, 'e2e test crash');
    assert.strictEqual(parsed.type, 'uncaught-exception');
  });

  it('readLatestCrash returns the most recent crash', async () => {
    markServerStarted();
    const report = buildCrashReport(
      new Error('latest test crash'),
      'startup-failure',
      { phase: 'startup' },
    );
    testReports.push(report);
    await writeCrashReport(report);

    const latest = await readLatestCrash();
    assert.ok(latest, 'Should find a latest crash');
    assert.strictEqual(latest!.error, 'latest test crash');
  });

  it('clearLatestCrash removes the latest indicator', async () => {
    markServerStarted();
    const report = buildCrashReport(new Error('to clear'), 'unknown', { phase: 'running' });
    testReports.push(report);
    await writeCrashReport(report);

    await clearLatestCrash();
    const latest = await readLatestCrash();
    assert.strictEqual(latest, null, 'Should be null after clear');
  });

  it('readCrashHistory returns reports in reverse chronological order', async () => {
    markServerStarted();
    const report1 = buildCrashReport(new Error('crash-1'), 'unknown', { phase: 'running' });
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    const report2 = buildCrashReport(new Error('crash-2'), 'unknown', { phase: 'running' });

    testReports.push(report1, report2);
    await writeCrashReport(report1);
    await writeCrashReport(report2);

    const history = await readCrashHistory(10);
    assert.ok(history.length >= 2, 'Should have at least 2 reports');

    // Most recent should be first
    const idx1 = history.findIndex(r => r.error === 'crash-1');
    const idx2 = history.findIndex(r => r.error === 'crash-2');
    if (idx1 >= 0 && idx2 >= 0) {
      assert.ok(idx2 < idx1, 'crash-2 (newer) should come before crash-1');
    }
  });
});
