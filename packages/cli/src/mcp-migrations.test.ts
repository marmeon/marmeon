import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { bin } from './__fixtures__/cli.ts';
import { initialize, mcpApp, mcpEnv, mcpSession, type McpSession } from './__fixtures__/mcp.ts';

const run = vi.hoisted(() => vi.fn());
// Only the tool this file runs in its own process uses the stand-in; the servers below are child processes with the real one.
vi.mock('./spawn.ts', () => ({ runMarmeonJson: run }));

const { MIGRATIONS_TOOL } = await import('./mcp/migrations.ts');

const formats = new URL('./__fixtures__/formats/', import.meta.url);
const stored = (path: string) => JSON.parse(readFileSync(new URL(path, formats), 'utf8'));
const call = async (session: McpSession, args: Record<string, unknown>) => (await session.request('tools/call', { name: 'migrations', arguments: args })).result;

const EXTRA = '2099_01_01_000000_create_notes_table.ts';

describe('migrations in an app', { timeout: 120_000 }, () => {
  let app: string;
  let session: McpSession;
  let bootLog: string;
  let env: Record<string, string>;
  const boots = () => (existsSync(bootLog) ? readFileSync(bootLog, 'utf8').split('\n').filter(Boolean).length : 0);

  beforeAll(async () => {
    app = mcpApp();
    // The format fixture pins the migrations of the app's tables; the blank app's other migrations are not part of the format.
    for (const file of readdirSync(join(app, 'modules/system/migrations'))) if (file.endsWith('_create_notifications_table.ts')) rmSync(join(app, 'modules/system/migrations', file));
    // The tests' .env has an in-memory database, which would forget what ran; a file keeps it between processes.
    const dir = realpathSync(tempDir('marmeon-mcp-migrations-'));
    bootLog = join(dir, 'boots.log');
    env = mcpEnv({ NODE_ENV: 'development', DB_DATABASE: join(dir, 'app.sqlite'), MCP_BOOT_LOG: bootLog });
    writeFileSync(join(app, 'modules/system/migrations', EXTRA), "export default { up(schema) { schema.create('notes', (t) => { t.id(); t.string('title'); }); } };\n");
    session = mcpSession(app, env);
    await initialize(session);
  });
  afterAll(() => session.close());

  it('lists everything as pending before marmeon migrate, and as ran after it', async () => {
    const before = await call(session, {});
    expect(before.isError).toBeUndefined();
    expect(before.structuredContent).toMatchObject({ database: true, connections: [{ name: 'default', ran: 0, pending: 2 }], total: 2 });
    expect(before.structuredContent.migrations.map((entry: { status: string }) => entry.status)).toEqual(['pending', 'pending']);

    // Bounded: the migration of a small SQLite app takes seconds.
    const migrated = spawnSync(process.execPath, [bin, 'migrate'], { cwd: app, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(migrated.status, migrated.stderr).toBe(0);

    const after = await call(session, {});
    expect(after.structuredContent).toMatchObject(stored('mcp-migrations/v1.json'));
    expect(Object.keys(after.structuredContent)[0]).toBe('format');
    expect(JSON.parse(after.content[0].text)).toEqual(after.structuredContent);
  });

  it('filters by status, module and connection, and cuts at the limit', async () => {
    const ran = (await call(session, { status: 'ran' })).structuredContent;
    expect(ran.total).toBe(2);
    expect((await call(session, { status: 'pending' })).structuredContent).toMatchObject({ total: 0, migrations: [] });
    expect((await call(session, { module: 'system' })).structuredContent.total).toBe(2);
    expect((await call(session, { module: 'other' })).structuredContent.total).toBe(0);
    expect((await call(session, { connection: 'default' })).structuredContent.total).toBe(2);
    expect((await call(session, { connection: 'reporting' })).structuredContent.total).toBe(0);
    const cut = (await call(session, { limit: 1 })).structuredContent;
    expect(cut).toMatchObject({ total: 2, truncated: true });
    expect(cut.migrations).toHaveLength(1);
    // The counts per connection are those of all migrations, not of the filter.
    expect((await call(session, { module: 'other' })).structuredContent.connections).toEqual([{ name: 'default', ran: 2, pending: 0 }]);
  });

  // Argument injection: the input is checked before any child process starts (the app records each boot).
  it.each([
    ['an option as the module', { module: '--force' }],
    ['a connection with a newline', { connection: 'system\n--seed' }],
    ['a connection that begins with an option', { connection: '--seed' }],
    ['a status that is none of the two', { status: 'all' }],
    ['a limit of zero', { limit: 0 }],
    ['a module with a newline', { module: 'system\n--force' }],
    ['a key the schema does not know', { '--force': true }],
  ])('refuses %s and starts nothing', async (_reason, input) => {
    const before = boots();
    const result = await call(session, input as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/validation/i);
    expect(boots()).toBe(before);
  });

  it('starts one process per call', async () => {
    const before = boots();
    await call(session, { status: 'ran' });
    expect(boots()).toBe(before + 1);
  });
});

describe('migrations when the app fails to start', { timeout: 120_000 }, () => {
  it('is an error that carries no password from the message of the failure', async () => {
    const app = mcpApp();
    // Assembled at run time: a literal address with a password would be a secret in the source.
    const password = ['hunter', '2', 'pw'].join('');
    const module = join(app, 'modules/system/index.ts');
    writeFileSync(module, `throw new Error('connection failed: DB_URL=postgres://app:${password}@127.0.0.1:1/app password=${password}');\n${readFileSync(module, 'utf8')}`);
    const session = mcpSession(app, mcpEnv({ NODE_ENV: 'development' }));
    try {
      await initialize(session);
      const result = await call(session, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('marmeon migrate:status failed:');
      expect(result.content[0].text).toContain('connection failed');
      expect(result.content[0].text).toContain('Run it in a terminal');
      expect(result.content[0].text).not.toContain(password);
    } finally {
      await session.close();
    }
  });
});

describe('migrations with the child process replaced', () => {
  let root: string;
  const context = () => ({ root, signal: new AbortController().signal });
  const exitedClean = { code: 0, document: undefined, stderrTail: '', timedOut: false, tooLarge: false };
  const answer = (document: unknown) => run.mockResolvedValueOnce({ ...exitedClean, document });
  const withPackage = () => {
    mkdirSync(join(root, 'node_modules/@marmeon/database'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@marmeon/database/package.json'), '{}');
  };

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mcp-migrations-stub-'));
    run.mockReset();
    run.mockResolvedValue(exitedClean);
  });

  it('answers an app without @marmeon/database with the stored document and starts nothing', async () => {
    expect(await MIGRATIONS_TOOL.run({}, context())).toEqual(stored('mcp-migrations/v1-no-database.json'));
    expect(run).not.toHaveBeenCalled();
  });

  it('starts exactly the fixed command, whatever the input says', async () => {
    withPackage();
    answer({ format: 1, migrations: [], warnings: [] });
    await MIGRATIONS_TOOL.run({ status: 'ran', module: 'system', connection: 'default', limit: 5 }, context());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(root, ['migrate:status', '--json'], expect.objectContaining({ timeoutMs: 120_000 }));
  });

  it('filters by names an app may use: a colon, a leading underscore, a non-ASCII letter', async () => {
    withPackage();
    const entries = [
      { name: 'a', module: 'berichte-ü', connection: 'reports:eu', batch: 1, status: 'ran' },
      { name: 'b', module: 'x', connection: '_legacy', batch: 1, status: 'ran' },
    ];
    answer({ format: 1, migrations: entries, warnings: [] });
    expect(((await MIGRATIONS_TOOL.run({ module: 'berichte-ü', connection: 'reports:eu' }, context())) as Record<string, any>).migrations).toEqual([entries[0]]);
    answer({ format: 1, migrations: entries, warnings: [] });
    expect(((await MIGRATIONS_TOOL.run({ connection: '_legacy' }, context())) as Record<string, any>).migrations).toEqual([entries[1]]);
    const schema = MIGRATIONS_TOOL.inputSchema.properties as Record<string, { pattern: string }>;
    for (const name of ['reports:eu', '_legacy', 'berichte-ü', 'x'.repeat(200)]) expect(new RegExp(schema.connection!.pattern).test(name), name).toBe(true);
    for (const name of ['--force', '-x', 'a\nb']) expect(new RegExp(schema.module!.pattern).test(name), name).toBe(false);
  });

  it('counts per connection over all entries, sorts them with the unknown one last, and treats a missing connection as unknown', async () => {
    withPackage();
    answer({
      format: 1,
      migrations: [
        { name: 'a', module: 'm', batch: 1, status: 'ran' },
        { name: 'b', module: 'm', connection: 'system', batch: null, status: 'pending' },
        { name: 'c', module: 'm', connection: 'default', batch: 1, status: 'ran' },
        { name: 'd', module: 'm', connection: 'default', batch: null, status: 'pending', extra: 'leaks' },
      ],
      warnings: ['a: the connection it runs on is unknown — marmeon migrate says why'],
    });
    const result = (await MIGRATIONS_TOOL.run({ connection: 'system' }, context())) as Record<string, any>;
    expect(result.connections).toEqual([
      { name: 'default', ran: 1, pending: 1 },
      { name: 'system', ran: 0, pending: 1 },
      { name: null, ran: 1, pending: 0 },
    ]);
    expect(result.migrations).toEqual([{ name: 'b', module: 'm', connection: 'system', batch: null, status: 'pending' }]);
    expect(result.warnings).toEqual(['a: the connection it runs on is unknown — marmeon migrate says why']);
    expect(JSON.stringify(result)).not.toContain('leaks');
  });

  it('refuses a document of another format, and an entry it cannot read', async () => {
    withPackage();
    answer({ format: 2, migrations: [], warnings: [] });
    expect(await MIGRATIONS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
    answer({ format: 1, migrations: [{ name: 'a' }], warnings: [] });
    expect(await MIGRATIONS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
  });

  it('passes on the end of stderr when the command fails, and says when it ran out of time', async () => {
    withPackage();
    run.mockResolvedValueOnce({ ...exitedClean, code: 1, stderrTail: 'boom\n' });
    expect(await MIGRATIONS_TOOL.run({}, context())).toEqual({ failure: 'marmeon migrate:status failed: boom. Run it in a terminal to see the whole message.' });
    run.mockResolvedValueOnce({ ...exitedClean, code: 1, timedOut: true });
    expect(await MIGRATIONS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('120 seconds') });
  });

  it('says that something wrote to stdout when the command exits 0 without one document', async () => {
    withPackage();
    expect(await MIGRATIONS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('did not print one JSON document') });
  });
});
