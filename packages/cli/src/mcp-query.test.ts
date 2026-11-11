import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { bin } from './__fixtures__/cli.ts';
import { initialize, mcpApp, mcpEnv, mcpSession, type McpSession } from './__fixtures__/mcp.ts';

const run = vi.hoisted(() => vi.fn());
// Only the tool this file runs in its own process uses the stand-in; the servers below are child processes with the real one.
vi.mock('./spawn.ts', () => ({ runMarmeonJson: run }));

const { QUERY_TOOL } = await import('./mcp/query.ts');

const formats = new URL('./__fixtures__/formats/', import.meta.url);
const stored = (path: string) => JSON.parse(readFileSync(new URL(path, formats), 'utf8'));
const call = async (session: McpSession, args: Record<string, unknown>) => (await session.request('tools/call', { name: 'query', arguments: args })).result;

describe('query in an app', { timeout: 120_000 }, () => {
  let app: string;
  let dir: string;
  let file: string;
  let session: McpSession;
  let unmanaged: McpSession;
  let unrecorded: McpSession;
  const noise = 'connected to db at /home/max/secret/app.sqlite as admin@db.internal';
  const count = () => {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      return (database.prepare('select count(*) as n from notes').get() as { n: number }).n;
    } finally {
      database.close();
    }
  };

  beforeAll(async () => {
    app = mcpApp();
    dir = realpathSync(tempDir('marmeon-mcp-query-'));
    file = join(dir, 'app.sqlite');
    const env = { NODE_ENV: 'development', DB_DRIVER: 'sqlite', DB_DATABASE: file };
    // The table comes from a migration: db:query refuses a database whose tables the record of migrations does not account for.
    writeFileSync(join(app, 'modules/system/migrations/2099_01_01_000000_create_notes_table.ts'), "export default { up(schema) { schema.create('notes', (t) => { t.id(); t.string('title'); }); } };\n");
    const migrated = spawnSync(process.execPath, [bin, 'migrate'], { cwd: app, env: mcpEnv(env), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(migrated.status, migrated.stderr).toBe(0);
    const database = new DatabaseSync(file);
    database.exec("insert into notes (title) values ('first'), ('second')");
    database.close();
    session = mcpSession(app, mcpEnv(env));
    // The app prints a path while it boots: it reaches the stderr of the child, ahead of the command's own line.
    unmanaged = mcpSession(app, mcpEnv({ ...env, DB_MANAGED: 'false', MCP_BOOT_NOISE: noise }));
    // A database that has a table and no record of migrations: which of its columns are secret cannot be established.
    const other = join(dir, 'unrecorded.sqlite');
    const raw = new DatabaseSync(other);
    raw.exec('create table loose (id integer primary key, body text)');
    raw.close();
    unrecorded = mcpSession(app, mcpEnv({ ...env, DB_DATABASE: other, MCP_BOOT_NOISE: noise }));
    await Promise.all([initialize(session), initialize(unmanaged), initialize(unrecorded)]);
  });
  afterAll(async () => {
    await Promise.all([session.close(), unmanaged.close(), unrecorded.close()]);
  });

  it('answers a select with the stored document', async () => {
    const result = await call(session, { sql: 'select id, title from notes order by id' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(stored('mcp-query/v1.json'));
    expect(Object.keys(result.structuredContent)[0]).toBe('format');
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.content[0].text).not.toContain(dir);
  });

  it('keeps to the limit and says that rows were left out', async () => {
    const result = await call(session, { sql: 'select id from notes order by id', limit: 1 });
    expect(result.structuredContent).toMatchObject({ rows: [[1]], truncated: true });
  });

  it('refuses a delete and leaves the table as it was', async () => {
    const result = await call(session, { sql: 'delete from notes' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^The query was refused: /);
    expect(count()).toBe(2);
  });

  it('refuses a connection that is not managed and answers nothing of its target', async () => {
    const result = await call(unmanaged, { sql: 'select title from notes' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^The query was refused: Connection "default" is not managed/);
    expect(result.content[0].text).not.toContain(dir);
    expect(result.content[0].text).not.toContain('/home/max');
    expect(result.content[0].text).not.toContain('admin@db.internal');
    expect(result.content[0].text).not.toContain('first');
  });

  it('says that a record of migrations that cannot name the secret columns refuses the query, and to run marmeon migrate', async () => {
    const result = await call(unrecorded, { sql: 'select body from loose' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^The query was refused: Which columns are secret cannot be established: the database has tables but no record of migrations\. Run marmeon migrate\.$/);
    expect(result.content[0].text).not.toContain('/home/max');
  });

  it('gives a fixed sentence, not the message of the database, when the query fails', async () => {
    const result = await call(session, { sql: 'select * from no_such_table' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Run marmeon db:query in a terminal');
    expect(result.content[0].text).not.toContain('no_such_table');
    expect(result.content[0].text).not.toContain(dir);
  });

  it('says so for a connection that does not exist, without the path of the database', async () => {
    const result = await call(session, { sql: 'select 1', database: 'nowhere' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(dir);
  });

  it.each([
    ['no sql', {}],
    ['an empty sql', { sql: '' }],
    ['an sql past 64 KiB', { sql: 'x'.repeat(65_537) }],
    ['a database that begins with an option', { sql: 'select 1', database: '--evil' }],
    ['a database with a newline', { sql: 'select 1', database: 'a\n--x' }],
    ['a limit of zero', { sql: 'select 1', limit: 0 }],
    ['a limit above 500', { sql: 'select 1', limit: 501 }],
    ['a key the schema does not know', { sql: 'select 1', timeout: 5 }],
  ])('refuses %s before a child starts', async (_reason, input) => {
    const result = await call(session, input);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/validation/i);
  });

  it('is announced as read-only', async () => {
    const { result } = await session.request('tools/list');
    expect(result.tools.find((tool: { name: string }) => tool.name === 'query').annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });
});

describe('query with the child process replaced', () => {
  let root: string;
  const controller = new AbortController();
  const context = (signal: AbortSignal = controller.signal) => ({ root, signal });
  const exited = { code: 0, document: undefined, stderrTail: '', timedOut: false, tooLarge: false };
  const document = { format: 1, connection: 'default', driver: 'sqlite', columns: [{ name: 'n', type: 'INTEGER' }], rows: [[1]], truncated: false, cut: 0, warnings: [] };
  const answer = (value: unknown, more: Record<string, unknown> = {}) => run.mockResolvedValueOnce({ ...exited, document: value, ...more });
  const withPackage = () => {
    mkdirSync(join(root, 'node_modules/@marmeon/database'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@marmeon/database/package.json'), '{}');
  };

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mcp-query-stub-'));
    run.mockReset();
    withPackage();
  });

  it('puts the SQL into the input of the child and never into its arguments', async () => {
    const sql = 'select 1\n--database=x "; rm -rf / ; -- --stdin';
    answer(document);
    await QUERY_TOOL.run({ sql, database: 'system', limit: 7 }, context());
    expect(run).toHaveBeenCalledTimes(1);
    const [calledRoot, args, options] = run.mock.calls[0] as [string, string[], { input: string; timeoutMs: number; maxStdoutBytes: number }];
    expect(calledRoot).toBe(root);
    expect(args).toEqual(['db:query', '--json', '--stdin', '--managed-only', '--limit=7', '--database=system']);
    expect(options.input).toBe(sql);
    expect(options).toMatchObject({ timeoutMs: 30_000, maxStdoutBytes: 16 * 1024 * 1024 });
    // No argument is the SQL or a line, or a word of it, beyond the fixed tokens.
    for (const part of ['select 1', '; rm -rf /', '"; rm', sql]) expect(args.join('\n')).not.toContain(part);
  });

  it('asks for the refusal of a connection that is not managed, and sends no database name by default', async () => {
    answer(document);
    await QUERY_TOOL.run({ sql: 'select 1' }, context());
    expect(run.mock.calls[0]![1]).toEqual(['db:query', '--json', '--stdin', '--managed-only', '--limit=50']);
  });

  it('answers with the stored document, field by field', async () => {
    answer({ ...document, target: '/secret/app.sqlite', extra: 1, columns: [{ name: 'n', type: 'INTEGER', origin: 'users.password' }] });
    const result = await QUERY_TOOL.run({ sql: 'select 1' }, context());
    expect(result).toEqual(document);
    expect(Object.keys(result)[0]).toBe('format');
  });

  it('refuses SQL past 64 KiB in bytes, without starting a child', async () => {
    expect(await QUERY_TOOL.run({ sql: 'ü'.repeat(40_000) }, context())).toEqual({ failure: expect.stringContaining('64 KiB') });
    expect(run).not.toHaveBeenCalled();
  });

  it('answers an app without @marmeon/database with an error and starts nothing', async () => {
    const bare = realpathSync(tempDir('marmeon-mcp-query-bare-'));
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, { root: bare, signal: controller.signal })).toEqual({ failure: expect.stringContaining('no database') });
    expect(run).not.toHaveBeenCalled();
  });

  it('passes on the last marked line of the reason of a refusal (exit 3) and nothing the app printed, cut at 300 characters', async () => {
    run.mockResolvedValueOnce({ ...exited, code: 3, stderrTail: 'connected to /home/x/app.sqlite\n✗ db:query refused: Column users.password is secret.\nat /home/x/app.sqlite\n' });
    expect(await QUERY_TOOL.run({ sql: 'select password from users' }, context())).toEqual({ failure: 'The query was refused: Column users.password is secret.' });
    run.mockResolvedValueOnce({ ...exited, code: 3, stderrTail: `✗ db:query refused: ${'x'.repeat(500)}\n` });
    const cut = (await QUERY_TOOL.run({ sql: 'select 1' }, context())) as { failure: string };
    expect(cut.failure).toBe(`The query was refused: ${'x'.repeat(300)}`);
    run.mockResolvedValueOnce({ ...exited, code: 3, stderrTail: '✗ db:query refused: Column users.password is secret.\n[info] shutdown after db:query refused: /home/x/app.sqlite\n' });
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context())).toEqual({ failure: 'The query was refused: Column users.password is secret.' });
    run.mockResolvedValueOnce({ ...exited, code: 3, stderrTail: '[info] shutdown after db:query refused: /home/x/app.sqlite\n' });
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context())).toEqual({ failure: 'The query was refused.' });
    run.mockResolvedValueOnce({ ...exited, code: 3, stderrTail: 'connected to /home/x/app.sqlite as admin\n' });
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context())).toEqual({ failure: 'The query was refused.' });
  });

  it('never passes on stderr: a fixed sentence for a failure of the database', async () => {
    run.mockResolvedValueOnce({ ...exited, code: 1, stderrTail: 'unable to open database file /home/max/app/storage/database.sqlite\n' });
    const result = (await QUERY_TOOL.run({ sql: 'select 1' }, context())) as { failure: string };
    expect(result.failure).toContain('Run marmeon db:query in a terminal');
    expect(result.failure).not.toContain('/home/max');
    run.mockResolvedValueOnce({ ...exited, code: 2, stderrTail: 'password=hunter2' });
    expect(((await QUERY_TOOL.run({ sql: 'select 1' }, context())) as { failure: string }).failure).not.toContain('hunter2');
  });

  it('refuses a document of another format, and one it cannot read', async () => {
    answer({ ...document, format: 2 });
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
    answer({ ...document, rows: 'x' });
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
    answer(undefined);
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context())).toEqual({ failure: expect.stringContaining('one JSON document') });
  });

  it('says when the call was cancelled, ran out of time or printed more than 16 MiB', async () => {
    const cancelled = new AbortController();
    run.mockImplementationOnce(async () => {
      cancelled.abort();
      return { ...exited, code: 1 };
    });
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context(cancelled.signal))).toEqual({ failure: expect.stringContaining('cancelled') });
    run.mockResolvedValueOnce({ ...exited, code: 1, timedOut: true });
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context())).toEqual({ failure: expect.stringContaining('30 seconds') });
    run.mockResolvedValueOnce({ ...exited, tooLarge: true });
    expect(await QUERY_TOOL.run({ sql: 'select 1' }, context())).toEqual({ failure: expect.stringContaining('16 MiB') });
  });
});
