import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { bin } from './__fixtures__/cli.ts';
import { initialize, mcpApp, mcpEnv, mcpSession, type McpSession } from './__fixtures__/mcp.ts';

const run = vi.hoisted(() => vi.fn());
// Only the tool this file runs in its own process uses the stand-in; the servers below are child processes with the real one.
vi.mock('./spawn.ts', () => ({ runMarmeonJson: run }));

const { DATABASE_TOOL } = await import('./mcp/database.ts');

const formats = new URL('./__fixtures__/formats/', import.meta.url);
const stored = (path: string) => JSON.parse(readFileSync(new URL(path, formats), 'utf8'));
const call = async (session: McpSession, args: Record<string, unknown>) => (await session.request('tools/call', { name: 'database', arguments: args })).result;

describe('database in an app', { timeout: 120_000 }, () => {
  let app: string;
  let session: McpSession;
  let bootLog: string;
  let env: Record<string, string>;
  const boots = () => (existsSync(bootLog) ? readFileSync(bootLog, 'utf8').split('\n').filter(Boolean).length : 0);

  beforeAll(async () => {
    app = mcpApp();
    // The tests' .env has an in-memory database, which would forget the tables between processes; a file keeps them.
    const dir = realpathSync(tempDir('marmeon-mcp-database-'));
    bootLog = join(dir, 'boots.log');
    env = mcpEnv({ NODE_ENV: 'development', DB_DATABASE: join(dir, 'app.sqlite'), MCP_BOOT_LOG: bootLog });
    session = mcpSession(app, env);
    await initialize(session);
    // Bounded: the migration of a small SQLite app takes seconds.
    const migrated = spawnSync(process.execPath, [bin, 'migrate'], { cwd: app, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(migrated.status, migrated.stderr).toBe(0);
  });
  afterAll(() => session.close());

  it('lists the driver, the server and the tables with their counts, and not where the connection points', async () => {
    const result = await call(session, {});
    expect(result.isError).toBeUndefined();
    const document = result.structuredContent;
    expect(Object.keys(document)[0]).toBe('format');
    expect(document).toMatchObject({ format: 1, database: true, connection: 'default', driver: 'sqlite', warnings: [] });
    expect(document.server).toMatch(/^SQLite \d/);
    expect(document.tables).toContainEqual({ name: 'migrations', schema: null, columns: 5, rows: 3 });
    for (const table of document.tables) expect(Object.keys(table).sort()).toEqual(['columns', 'name', 'rows', 'schema']);
    expect(Object.keys(document).sort()).toEqual(['connection', 'database', 'driver', 'format', 'server', 'tables', 'warnings']);
    expect(JSON.parse(result.content[0].text)).toEqual(document);
  });

  it('says what the command says about a connection that does not exist', async () => {
    const result = await call(session, { connection: 'nowhere' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('marmeon db:show failed:');
    expect(result.content[0].text).toContain('nowhere');
  });

  // Argument injection: the input is checked before any child process starts (the app records each boot).
  it.each([
    ['an option', { connection: '--seed' }],
    ['a line break', { connection: 'system\n--seed' }],
    ['64 characters', { connection: 'a'.repeat(64) }],
    ['an empty name', { connection: '' }],
    ['a key the schema does not know', { target: true }],
  ])('refuses %s and starts nothing', async (_reason, input) => {
    const before = boots();
    const result = await call(session, input as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/validation/i);
    expect(boots()).toBe(before);
  });
});

describe('database with the child process replaced', () => {
  let root: string;
  const context = () => ({ root, signal: new AbortController().signal });
  const exitedClean = { code: 0, document: undefined, stderrTail: '', timedOut: false, tooLarge: false };
  const answer = (document: unknown) => run.mockResolvedValueOnce({ ...exitedClean, document });
  const withPackage = () => {
    mkdirSync(join(root, 'node_modules/@marmeon/database'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@marmeon/database/package.json'), '{}');
  };
  const shown = { format: 1, connection: 'default', driver: 'pgsql', server: 'PostgreSQL 18.6', tables: [{ name: 'users', schema: 'public', columns: 4, rows: 3 }], warnings: [] };

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mcp-database-stub-'));
    run.mockReset();
    run.mockResolvedValue(exitedClean);
  });

  it('answers an app without @marmeon/database with the stored document and starts nothing', async () => {
    expect(await DATABASE_TOOL.run({}, context())).toEqual(stored('mcp-database/v1-no-database.json'));
    expect(run).not.toHaveBeenCalled();
  });

  it('starts exactly the fixed command, with the connection as one token', async () => {
    withPackage();
    answer(shown);
    await DATABASE_TOOL.run({}, context());
    expect(run).toHaveBeenLastCalledWith(root, ['db:show', '--json'], expect.objectContaining({ timeoutMs: 120_000 }));
    answer(shown);
    await DATABASE_TOOL.run({ connection: 'system' }, context());
    expect(run).toHaveBeenLastCalledWith(root, ['db:show', '--json', '--database=system'], expect.objectContaining({ timeoutMs: 120_000 }));
  });

  it('does not pass on the target or a key the document carries besides the known ones', async () => {
    withPackage();
    answer({ ...shown, target: 'pgsql postgres://u:***@h/db', password: 'x', tables: [{ ...shown.tables[0], password: 'y' }] });
    const result = await DATABASE_TOOL.run({}, context());
    expect(result).toEqual({ ...shown, database: true });
    const text = JSON.stringify(result);
    for (const leak of ['target', 'postgres://', 'password']) expect(text).not.toContain(leak);
  });

  it('accepts the names an app may use and refuses the ones that look like options', () => {
    const { pattern } = (DATABASE_TOOL.inputSchema.properties as Record<string, { pattern: string }>).connection!;
    for (const name of ['default', 'system', '_legacy', 'reports.eu', 'a-b', 'x'.repeat(63)]) expect(new RegExp(pattern).test(name), name).toBe(true);
    for (const name of ['--force', '-x', '1a', 'a\nb', 'a b', 'x'.repeat(64)]) expect(new RegExp(pattern).test(name), name).toBe(false);
  });

  it('refuses a document of another format, and a table it cannot read', async () => {
    withPackage();
    answer({ ...shown, format: 2 });
    expect(await DATABASE_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
    answer({ ...shown, tables: [{ name: 'users' }] });
    expect(await DATABASE_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
  });

  it('passes on the end of stderr when the command fails, and says when it ran out of time', async () => {
    withPackage();
    run.mockResolvedValueOnce({ ...exitedClean, code: 1, stderrTail: 'boom\n' });
    expect(await DATABASE_TOOL.run({}, context())).toEqual({ failure: 'marmeon db:show failed: boom. Run it in a terminal to see the whole message.' });
    run.mockResolvedValueOnce({ ...exitedClean, code: 1, timedOut: true });
    expect(await DATABASE_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('120 seconds') });
  });

  it('says when the call was cancelled, and when the document was too large', async () => {
    withPackage();
    const cancelled = new AbortController();
    cancelled.abort();
    run.mockResolvedValueOnce({ ...exitedClean, code: 1 });
    expect(await DATABASE_TOOL.run({}, { root, signal: cancelled.signal })).toEqual({ failure: expect.stringContaining('cancelled') });
    run.mockResolvedValueOnce({ ...exitedClean, tooLarge: true });
    expect(await DATABASE_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('16 MiB') });
  });

  it('says that something wrote to stdout when the command exits 0 without one document', async () => {
    withPackage();
    expect(await DATABASE_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('did not print one JSON document') });
  });
});
