import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { bin } from './__fixtures__/cli.ts';
import { initialize, mcpApp, mcpEnv, mcpSession, type McpSession } from './__fixtures__/mcp.ts';
import { checkTool } from './mcp/check.ts';
import { runMarmeonJson } from './spawn.ts';

const formats = new URL('./__fixtures__/formats/', import.meta.url);
const stored = (path: string) => JSON.parse(readFileSync(new URL(path, formats), 'utf8'));
const options = { timeoutMs: 30_000, maxStdoutBytes: 1_000_000 };

afterEach(() => vi.unstubAllEnvs());

/**
 * Ends the process of `pidFile` (and its group) when the test failed: a failed test must leave nothing running. A passed test
 * already saw it gone, and a pid signalled after that could belong to another process by then.
 */
function reapAfterTest(pidFile: string): void {
  onTestFinished(({ task }) => {
    if (task.result?.state !== 'fail') return;
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid > 0) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Not a group leader.
        }
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // No file, or the process is gone.
    }
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function untilGone(pid: number, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (!alive(pid)) return true;
  }
  return !alive(pid);
}

async function untilFile(file: string, ms = 20_000): Promise<number> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (existsSync(file) && readFileSync(file, 'utf8').trim() !== '') return Number(readFileSync(file, 'utf8'));
  }
  throw new Error(`${file} was not written`);
}

/**
 * A stand-in for `bin/marmeon.js`: ignores SIGTERM and starts a grandchild that ignores it too and keeps the inherited pipes open,
 * the way the source launcher's second Node process does. `EXIT_AT_ONCE` makes the stand-in itself end right after the start.
 */
const STUBBORN = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: 'inherit' });
writeFileSync(process.env.PID_FILE, String(grandchild.pid));
if (process.env.EXIT_AT_ONCE) process.exit(0);
setTimeout(() => process.exit(0), 60000);
`;

function stubborn(env: Record<string, string>) {
  const dir = tempDir('marmeon-mcp-stubborn-');
  const launcher = join(dir, 'launcher.mjs');
  writeFileSync(launcher, STUBBORN);
  const pidFile = join(dir, 'grandchild.pid');
  for (const [key, value] of Object.entries({ PID_FILE: pidFile, ...env })) vi.stubEnv(key, value);
  reapAfterTest(pidFile);
  return { launcher, pidFile };
}

describe('runMarmeonJson ends the whole process group', { timeout: 60_000 }, () => {
  it('kills a child that ignores SIGTERM and the grandchild that keeps the pipes open, and gives the result', async () => {
    const { launcher, pidFile } = stubborn({});
    // Long enough for the stand-in to set its SIGTERM handler and start the grandchild on a slow runner.
    const running = runMarmeonJson('/', [], { ...options, timeoutMs: 5_000, launcher });
    const grandchild = await untilFile(pidFile);
    const run = await running;
    expect(run.timedOut).toBe(true);
    expect(await untilGone(grandchild)).toBe(true);
  });

  it('kills the group when the signal aborts', async () => {
    const { launcher, pidFile } = stubborn({});
    const controller = new AbortController();
    const running = runMarmeonJson('/', [], { ...options, signal: controller.signal, launcher });
    const grandchild = await untilFile(pidFile);
    controller.abort();
    await running;
    expect(await untilGone(grandchild)).toBe(true);
  });

  it('gives the result and kills the grandchild when the child exited but a grandchild still holds the pipes', async () => {
    const { launcher, pidFile } = stubborn({ EXIT_AT_ONCE: '1' });
    const started = Date.now();
    const run = await runMarmeonJson('/', [], { ...options, launcher });
    // Long before the time limit: the drain period ended it.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.code).toBe(0);
    expect(await untilGone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  });

  it('reads the document of the exit codes it is told to', async () => {
    const dir = tempDir('marmeon-mcp-exit-');
    const launcher = join(dir, 'launcher.mjs');
    writeFileSync(launcher, "console.log('{\"format\":1}'); process.exit(1);");
    expect((await runMarmeonJson('/', [], { ...options, launcher })).document).toBeUndefined();
    expect((await runMarmeonJson('/', [], { ...options, launcher, documentCodes: [0, 1] })).document).toEqual({ format: 1 });
  });
});

/** The app gets a check that never ends and writes the pid of the process it runs in to `CHECK_PID_FILE`. */
function withHangingCheck(app: string): void {
  const file = join(app, 'modules/system/index.ts');
  const hang = [
    "import { writeFileSync } from 'node:fs';",
    'class HangCheck {',
    "  static check = 'hang';",
    "  static phase = 'build' as const;",
    '  handle() {',
    '    writeFileSync(process.env.CHECK_PID_FILE!, String(process.pid));',
    '    setInterval(() => {}, 1000);',
    '    setTimeout(() => process.exit(1), 60_000);',
    '    return new Promise<never>(() => {});',
    '  }',
    '}',
    '',
  ].join('\n');
  writeFileSync(file, hang + readFileSync(file, 'utf8').replace("name: 'system',", "name: 'system',\n  checks: [HangCheck],"));
}

const call = async (session: McpSession, args: Record<string, unknown>) => (await session.request('tools/call', { name: 'check', arguments: args })).result;

describe('check', { timeout: 120_000 }, () => {
  let app: string;
  let session: McpSession;
  let bootLog: string;
  let pidFile: string;
  const boots = () => (existsSync(bootLog) ? readFileSync(bootLog, 'utf8').split('\n').filter(Boolean).length : 0);

  beforeAll(async () => {
    app = mcpApp();
    withHangingCheck(app);
    const dir = tempDir('marmeon-mcp-check-');
    bootLog = join(dir, 'boots.log');
    pidFile = join(dir, 'check.pid');
    mkdirSync(join(app, 'modules/system/lib'));
    session = mcpSession(app, mcpEnv({ NODE_ENV: 'development', MCP_BOOT_LOG: bootLog, CHECK_PID_FILE: pidFile }));
    await initialize(session);
  });
  afterAll(() => session.close());

  it('matches the stored report of a passing run, with the format first and the same document as text', async () => {
    const result = await call(session, { only: ['internal-imports'] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject(stored('mcp-check/v1.json'));
    expect(Object.keys(result.structuredContent)[0]).toBe('format');
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it('hands over the report of a run that found errors (exit 1), cut to maxProblems per check', async () => {
    writeFileSync(join(app, 'modules/system/lib/bad.ts'), "import '@marmeon/core/internal';\nimport '@marmeon/http/internal';\n");
    const failed = await call(session, { only: ['internal-imports'] });
    expect(failed.isError).toBeUndefined();
    expect(failed.structuredContent).toMatchObject(stored('mcp-check/v1-failed.json'));
    expect(failed.structuredContent.truncated).toBe(false);
    expect(failed.structuredContent.report.checks[0].problems).toHaveLength(2);

    const cut = await call(session, { only: ['internal-imports'], maxProblems: 1 });
    expect(cut.structuredContent.truncated).toBe(true);
    expect(cut.structuredContent.report.checks[0].problems).toHaveLength(1);
    expect(cut.structuredContent.warnings).toHaveLength(1);
  });

  it('refuses an unknown check name with the list of the checks', async () => {
    const result = await call(session, { only: ['no-such-check'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('names no check: no-such-check');
    expect(result.content[0].text).toContain('internal-imports');
  });

  // Argument injection: the input is checked before any child process starts. A name the schema let through would reach the
  // command line, load the app (which records a boot) and fail there.
  it.each([
    ['an option as a name', { only: ['--force'] }],
    ['a name that smuggles an option', { only: ['types,lint --skip'] }],
    ['a name with a comma', { skip: ['types,lint'] }],
    ['a name that begins with a dash', { skip: ['-types'] }],
    ['an upper-case name', { only: ['Types'] }],
    ['a name with a newline', { only: ['types\n--force'] }],
    ['an empty list', { only: [] }],
    ['a name that repeats', { only: ['types', 'types'] }],
    ['too many names', { only: Array.from({ length: 21 }, (_, index) => `check-${index}`) }],
    ['a name that is too long', { only: ['a'.repeat(65)] }],
    ['a string instead of a list', { only: 'types' }],
    ['maxProblems of 0', { maxProblems: 0 }],
    ['maxProblems above the maximum', { maxProblems: 1001 }],
    ['a key the schema does not know', { '--force': true }],
  ])('refuses %s and starts nothing', async (_reason, input) => {
    const before = boots();
    const result = await call(session, input as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/validation/i);
    expect(boots()).toBe(before);
  });

  it('refuses a second call while one runs, and answers the first', async () => {
    const first = call(session, { only: ['internal-imports'] });
    const second = await call(session, { only: ['internal-imports'] });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toBe('A check is running; wait for its result.');
    expect((await first).isError).toBeUndefined();
    // Free again.
    expect((await call(session, { only: ['internal-imports'] })).isError).toBeUndefined();
  });

  it('stops the app, its launcher and everything below when the client cancels the call', async () => {
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], cwd: app, env: mcpEnv({ NODE_ENV: 'development', CHECK_PID_FILE: pidFile }), stderr: 'pipe' });
    await client.connect(transport);
    try {
      reapAfterTest(pidFile);
      const controller = new AbortController();
      const running = client.callTool({ name: 'check', arguments: { only: ['hang'] } }, { signal: controller.signal });
      const rejected = expect(running).rejects.toBeDefined();
      const pid = await untilFile(pidFile);
      expect(alive(pid)).toBe(true);
      controller.abort();
      await rejected;
      expect(await untilGone(pid, 15_000)).toBe(true);
      // The queue is free again: the next call is answered.
      const next = await client.callTool({ name: 'check', arguments: { only: ['internal-imports'] } });
      expect(next.isError).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('stops a run that exceeds its time limit and says so', async () => {
    writeFileSync(pidFile, '');
    reapAfterTest(pidFile);
    vi.stubEnv('CHECK_PID_FILE', pidFile);
    // Long enough for the app to boot and the check to write its pid on a slow runner; an empty file would make the pid 0.
    const tool = checkTool({ timeoutMs: 20_000 });
    const result = await tool.run({ only: ['hang'] }, { root: app, signal: new AbortController().signal });
    expect(result).toEqual({ failure: 'marmeon check did not finish within 10 minutes; run it in a terminal, or narrow it with only.' });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(await untilGone(pid, 15_000)).toBe(true);
  });
});
