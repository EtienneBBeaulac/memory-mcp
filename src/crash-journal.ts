// Crash journal: persistent, human-readable record of MCP server failures.
//
// Design principles:
//   - Errors are data: crashes become structured records, not silent deaths
//   - Observability as a constraint: every failure is visible on next startup
//   - Fail fast with meaningful messages: journal then die, don't zombie
//
// Location: ~/.memory-mcp/crashes/
//   crash-<timestamp>.json  — one file per crash (no write conflicts)
//   LATEST.json             — symlink/copy of most recent crash (fast access)

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

/** A single crash report */
export interface CrashReport {
  readonly timestamp: string;         // ISO 8601
  readonly pid: number;
  readonly error: string;             // error message
  readonly stack?: string;            // stack trace
  readonly type: CrashType;
  readonly context: CrashContext;
  readonly recovery: string[];        // human-readable recovery steps
  readonly serverUptime: number;      // seconds since startup
}

export type CrashType =
  | 'uncaught-exception'
  | 'unhandled-rejection'
  | 'startup-failure'
  | 'lobe-init-failure'
  | 'transport-error'
  | 'unknown';

/** What the server was doing when it crashed */
export interface CrashContext {
  readonly phase: 'startup' | 'running' | 'migration' | 'shutdown';
  readonly lastToolCall?: string;     // last tool name if during running phase
  readonly activeLobe?: string;       // which lobe was involved if applicable
  readonly configSource?: string;     // how config was loaded
  readonly lobeCount?: number;
}

const CRASH_DIR = path.join(os.homedir(), '.memory-mcp', 'crashes');
const LATEST_FILE = path.join(CRASH_DIR, 'LATEST.json');
const MAX_CRASH_FILES = 20; // keep last 20 crash reports

let serverStartTime = Date.now();

/** Reset the start time (called on startup) */
export function markServerStarted(): void {
  serverStartTime = Date.now();
}

/** Write a crash report to disk. Synchronous — must work even in dying process. */
export async function writeCrashReport(report: CrashReport): Promise<string> {
  await fs.mkdir(CRASH_DIR, { recursive: true });

  const filename = `crash-${report.timestamp.replace(/[:.]/g, '-')}.json`;
  const filepath = path.join(CRASH_DIR, filename);
  const content = JSON.stringify(report, null, 2);

  await fs.writeFile(filepath, content, 'utf-8');
  await fs.writeFile(LATEST_FILE, content, 'utf-8');

  // Prune old crash files (keep newest MAX_CRASH_FILES)
  try {
    const files = (await fs.readdir(CRASH_DIR))
      .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
      .sort()
      .reverse();

    for (const old of files.slice(MAX_CRASH_FILES)) {
      await fs.unlink(path.join(CRASH_DIR, old)).catch(() => {});
    }
  } catch { /* pruning is best-effort */ }

  return filepath;
}

/** Synchronous version for use in process exit handlers where async isn't reliable */
export function writeCrashReportSync(report: CrashReport): string | null {
  const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs');
  try {
    mkdirSync(CRASH_DIR, { recursive: true });
    const filename = `crash-${report.timestamp.replace(/[:.]/g, '-')}.json`;
    const filepath = path.join(CRASH_DIR, filename);
    const content = JSON.stringify(report, null, 2);
    writeFileSync(filepath, content, 'utf-8');
    writeFileSync(LATEST_FILE, content, 'utf-8');
    return filepath;
  } catch {
    return null;
  }
}

/** Build a CrashReport from an error */
export function buildCrashReport(
  error: unknown,
  type: CrashType,
  context: CrashContext,
): CrashReport {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  const recovery = generateRecoverySteps(type, message, context);

  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    error: message,
    stack,
    type,
    context,
    recovery,
    serverUptime: Math.round((Date.now() - serverStartTime) / 1000),
  };
}

/** Generate human-readable recovery instructions based on crash type */
function generateRecoverySteps(type: CrashType, message: string, context: CrashContext): string[] {
  const steps: string[] = [];

  // Common first step
  steps.push('Toggle the memory MCP off and on in Firebender to restart the server.');

  switch (type) {
    case 'startup-failure':
      if (message.includes('memory-config.json')) {
        steps.push('Check memory-config.json for syntax errors (invalid JSON).');
        steps.push('Verify all "root" paths in lobe definitions exist on disk.');
      }
      if (message.includes('ENOENT') || message.includes('not found')) {
        steps.push(`Verify the path exists: check if the directory referenced in the error is accessible.`);
      }
      steps.push('Try running: node /path/to/memory-mcp/dist/index.js directly to see stderr output.');
      break;

    case 'lobe-init-failure':
      steps.push(`The lobe "${context.activeLobe}" failed to initialize.`);
      steps.push('Check that the repo root exists and is accessible.');
      steps.push('Verify git is installed if the repo uses .git/memory/ storage.');
      steps.push('Other lobes may still work — the server continues in degraded mode.');
      break;

    case 'uncaught-exception':
    case 'unhandled-rejection':
      steps.push('This is likely a bug in the memory MCP server.');
      steps.push('If reproducible, note what tool call triggered it and report the issue.');
      if (message.includes('ENOSPC')) {
        steps.push('Disk is full — free space and restart.');
      }
      if (message.includes('EACCES') || message.includes('EPERM')) {
        steps.push('Permission error — check file permissions on ~/.memory-mcp/ and the repo .git/memory/ directories.');
      }
      break;

    case 'transport-error':
      steps.push('The communication channel between Firebender and the MCP broke.');
      steps.push('This usually happens when the IDE restarts or the MCP is toggled.');
      steps.push('Simply toggle the MCP off and on — this is expected behavior.');
      break;

    default:
      steps.push('Check the stack trace for details.');
  }

  return steps;
}

/** Read the most recent crash report (if any) */
export async function readLatestCrash(): Promise<CrashReport | null> {
  try {
    const content = await fs.readFile(LATEST_FILE, 'utf-8');
    return JSON.parse(content) as CrashReport;
  } catch {
    return null;
  }
}

/** Read all crash reports, newest first */
export async function readCrashHistory(limit: number = 10): Promise<CrashReport[]> {
  try {
    const files = (await fs.readdir(CRASH_DIR))
      .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);

    const reports: CrashReport[] = [];
    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(CRASH_DIR, file), 'utf-8');
        reports.push(JSON.parse(content));
      } catch { /* skip corrupt files */ }
    }
    return reports;
  } catch {
    return [];
  }
}

/** Clear the latest crash indicator (call after successfully showing it to user) */
export async function clearLatestCrash(): Promise<void> {
  try {
    await fs.unlink(LATEST_FILE);
  } catch { /* already gone */ }
}

/** Format a crash report for display in an MCP tool response */
export function formatCrashReport(report: CrashReport): string {
  const lines: string[] = [
    `## ⚠ Memory MCP Crash Report`,
    ``,
    `**When:** ${report.timestamp}`,
    `**Type:** ${report.type}`,
    `**Phase:** ${report.context.phase}`,
    `**Uptime:** ${report.serverUptime}s before crash`,
    `**Error:** ${report.error}`,
  ];

  if (report.context.lastToolCall) {
    lines.push(`**Last tool call:** ${report.context.lastToolCall}`);
  }
  if (report.context.activeLobe) {
    lines.push(`**Affected lobe:** ${report.context.activeLobe}`);
  }

  lines.push('');
  lines.push('### Recovery Steps');
  for (const step of report.recovery) {
    lines.push(`- ${step}`);
  }

  if (report.stack) {
    lines.push('');
    lines.push('### Stack Trace');
    lines.push('```');
    // Truncate very long stacks
    const stackLines = report.stack.split('\n').slice(0, 10);
    lines.push(stackLines.join('\n'));
    if (report.stack.split('\n').length > 10) {
      lines.push('... (truncated)');
    }
    lines.push('```');
  }

  return lines.join('\n');
}

/** Format a short crash summary for briefing inclusion */
export function formatCrashSummary(report: CrashReport): string {
  const age = Math.round((Date.now() - new Date(report.timestamp).getTime()) / 1000 / 60);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
  return `[!] Server crashed ${ageStr}: ${report.type} — ${report.error.substring(0, 100)}`;
}
