import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { repo } from './__fixtures__/cli.ts';
import { initialize, mcpApp, mcpEnv, mcpSession, type McpSession } from './__fixtures__/mcp.ts';

const run = vi.hoisted(() => vi.fn());
// Only the tool this file runs in its own process uses the stand-in; the servers below are child processes with the real one.
vi.mock('./spawn.ts', () => ({ runMarmeonJson: run }));

const { SCHEMA_TOOL } = await import('./mcp/schema.ts');

const formats = new URL('./__fixtures__/formats/', import.meta.url);
const stored = (path: string) => JSON.parse(readFileSync(new URL(path, formats), 'utf8'));
const call = async (session: McpSession, args: Record<string, unknown>) => (await session.request('tools/call', { name: 'schema', arguments: args })).result;

describe('schema in an app', { timeout: 120_000 }, () => {
  let app: string;
  let session: McpSession;
  let bootLog: string;
  const boots = () => (existsSync(bootLog) ? readFileSync(bootLog, 'utf8').split('\n').filter(Boolean).length : 0);

  beforeAll(async () => {
    app = mcpApp();
    // The format fixture pins the migrations of the app's tables; the blank app's other migrations are not part of the format.
    for (const file of readdirSync(join(app, 'modules/system/migrations'))) if (file.endsWith('_create_notifications_table.ts')) rmSync(join(app, 'modules/system/migrations', file));
    bootLog = join(tempDir('marmeon-mcp-schema-boots-'), 'boots.log');
    session = mcpSession(app, mcpEnv({ NODE_ENV: 'development', MCP_BOOT_LOG: bootLog }));
    await initialize(session);
  });
  afterAll(() => session.close());

  it('matches the stored projection, with the format first and the same document as text', async () => {
    const result = await call(session, {});
    expect(result.isError).toBeUndefined();
    // The version of @marmeon/database changes with each release; the inner shape is that package's own fixture.
    const { database: _version, ...stable } = stored('mcp-schema/v1.json').projection;
    expect(result.structuredContent).toMatchObject({ ...stored('mcp-schema/v1.json'), projection: stable });
    expect(typeof result.structuredContent.projection.database).toBe('string');
    expect(Object.keys(result.structuredContent)[0]).toBe('format');
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it('computes the projection afresh: a migration added after the file was written is in the answer', async () => {
    const migration = join(app, 'modules/system/migrations/2099_01_01_000000_create_notes_table.ts');
    writeFileSync(migration, "export default { up(schema) { schema.create('notes', (t) => { t.id(); t.string('title'); }); } };\n");
    try {
      const result = await call(session, {});
      expect(Object.keys(result.structuredContent.projection.tables)).toContain('notes');
    } finally {
      rmSync(migration);
    }
  });

  it('gives one table when asked for it, and names the tables when it is unknown', async () => {
    const one = await call(session, { table: 'jobs' });
    expect(Object.keys(one.structuredContent.projection.tables)).toEqual(['jobs']);
    expect(one.structuredContent.projection.migrations).toHaveLength(1);

    const unknown = await call(session, { table: 'nothing' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toBe('The migrations describe no table "nothing". Tables: jobs, failed_jobs.');
    // A name that exists on every object is still no table.
    expect((await call(session, { table: 'constructor' })).isError).toBe(true);
  });

  it('starts one process per call', async () => {
    const before = boots();
    await call(session, { table: 'jobs' });
    expect(boots()).toBe(before + 1);
  });

  // Argument injection: the input is checked before any child process starts (the app records each boot).
  it.each([
    ['an option', { table: '--force' }],
    ['a name that smuggles a command', { table: 'users; drop' }],
    ['a name with a newline', { table: 'jobs\n--force' }],
    ['a name that begins with a digit', { table: '1jobs' }],
    ['an empty name', { table: '' }],
    ['a name that is too long', { table: 'a'.repeat(64) }],
    ['a number', { table: 1 }],
    ['a key the schema does not know', { '--force': true }],
  ])('refuses %s and starts nothing', async (_reason, input) => {
    const before = boots();
    const result = await call(session, input as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/validation/i);
    expect(boots()).toBe(before);
  });
});

describe('schema in an app without @marmeon/database', { timeout: 120_000 }, () => {
  it('matches the stored answer', async () => {
    const app = mcpApp();
    const blank = join(repo, 'apps/blank-app');
    // A node_modules with every package but @marmeon/database; the app has no migration of its own then.
    rmSync(join(app, 'node_modules'));
    mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true });
    for (const entry of readdirSync(join(blank, 'node_modules'))) if (entry !== '@marmeon') symlinkSync(join(blank, 'node_modules', entry), join(app, 'node_modules', entry));
    for (const entry of readdirSync(join(blank, 'node_modules/@marmeon'))) if (entry !== 'database') symlinkSync(join(blank, 'node_modules/@marmeon', entry), join(app, 'node_modules/@marmeon', entry));
    rmSync(join(app, 'modules/system/migrations'), { recursive: true });
    writeFileSync(join(app, 'modules/system/index.ts'), "import { defineModule } from '@marmeon/core';\nexport default defineModule({ name: 'system' });\n");
    const session = mcpSession(realpathSync(app), mcpEnv({ NODE_ENV: 'development' }));
    try {
      await initialize(session);
      const result = await call(session, {});
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(stored('mcp-schema/v1-no-database.json'));
    } finally {
      await session.close();
    }
  });
});

describe('schema when the file is not what the command wrote', () => {
  let root: string;
  const context = () => ({ root, signal: new AbortController().signal });
  const exitedClean = { code: 0, document: undefined, stderrTail: '', timedOut: false, tooLarge: false };
  const file = (value: unknown) => {
    mkdirSync(join(root, '.marmeon'), { recursive: true });
    writeFileSync(join(root, '.marmeon/schema.json'), typeof value === 'string' ? value : JSON.stringify(value));
  };

  /** The app has `@marmeon/database` installed (a stub: the tool only asks whether the package is there). */
  const withPackage = () => {
    mkdirSync(join(root, 'node_modules/@marmeon/database'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@marmeon/database/package.json'), '{}');
  };
  const withoutPackage = () => rmSync(join(root, 'node_modules'), { recursive: true });

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mcp-schema-file-'));
    run.mockReset();
    run.mockResolvedValue(exitedClean);
    withPackage();
  });

  it('reads the command with a fixed argument list and nothing from the input', async () => {
    file({ format: 2, tables: {} });
    await SCHEMA_TOOL.run({ table: 'x' }, context());
    expect(run).toHaveBeenCalledWith(root, ['schema:project'], expect.objectContaining({ timeoutMs: 120_000 }));
  });

  it('refuses a file of another format without its content', async () => {
    file({ format: 3, tables: { secret_table: {} } });
    const result = await SCHEMA_TOOL.run({}, context());
    expect(result).toEqual({ failure: '.marmeon/schema.json has format 3; this marmeon reads 2 — update marmeon.' });
  });

  it.each([['no format', { tables: {} }], ['a text', 'nope'], ['null', 'null'], ['a list', '[]']])('refuses a file with %s', async (_name, value) => {
    file(value);
    const result = await SCHEMA_TOOL.run({}, context());
    expect(result).toHaveProperty('failure');
  });

  it('refuses a file that is not JSON', async () => {
    file('{ nope');
    expect(await SCHEMA_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('not valid JSON') });
  });

  it('refuses a link to a file outside the app and returns nothing of it', async () => {
    const outside = join(realpathSync(tempDir('marmeon-mcp-schema-outside-')), 'schema.json');
    writeFileSync(outside, JSON.stringify({ format: 2, tables: { stolen: {} } }));
    mkdirSync(join(root, '.marmeon'));
    symlinkSync(outside, join(root, '.marmeon/schema.json'));
    const result = await SCHEMA_TOOL.run({}, context());
    expect(result).toEqual({ failure: '.marmeon/schema.json is not a regular file inside the app, so it was not read.' });
    expect(JSON.stringify(result)).not.toContain('stolen');
  });

  it('refuses .marmeon as a link to a directory outside the app and returns nothing of it', async () => {
    const outside = realpathSync(tempDir('marmeon-mcp-schema-outside-'));
    writeFileSync(join(outside, 'schema.json'), JSON.stringify({ format: 2, tables: { stolen: {} } }));
    symlinkSync(outside, join(root, '.marmeon'), 'dir');
    const result = await SCHEMA_TOOL.run({}, context());
    expect(result).toEqual({ failure: '.marmeon/schema.json is not a regular file inside the app, so it was not read.' });
    expect(JSON.stringify(result)).not.toContain('stolen');
  });

  it('says the schema could not be written when the package is installed and the command left no file', async () => {
    expect(await SCHEMA_TOOL.run({}, context())).toEqual({ failure: '.marmeon/schema.json could not be written; run marmeon schema:project in a terminal to see why.' });
  });

  it('does not echo a format that is no integer', async () => {
    file({ format: 'x'.repeat(5000), tables: {} });
    const result = await SCHEMA_TOOL.run({}, context());
    expect(result).toEqual({ failure: '.marmeon/schema.json has format none; this marmeon reads 2 — update marmeon.' });
  });

  const stale = () => {
    file({ format: 2, tables: { stale_table: {} } });
  };

  it('does not return a stale file as current when the app has no @marmeon/database', async () => {
    stale();
    withoutPackage();
    const result = await SCHEMA_TOOL.run({}, context());
    expect(result).toEqual(stored('mcp-schema/v1-no-database.json'));
    expect(JSON.stringify(result)).not.toContain('stale_table');
  });

  it('still refuses a link in place of the file when the package is absent', async () => {
    withoutPackage();
    const outside = join(realpathSync(tempDir('marmeon-mcp-schema-outside-')), 'schema.json');
    writeFileSync(outside, JSON.stringify({ format: 2, tables: { stolen: {} } }));
    mkdirSync(join(root, '.marmeon'));
    symlinkSync(outside, join(root, '.marmeon/schema.json'));
    expect(await SCHEMA_TOOL.run({}, context())).toEqual({ failure: '.marmeon/schema.json is not a regular file inside the app, so it was not read.' });
  });

  it('says the app has no database when the command succeeded and left no file', async () => {
    withoutPackage();
    expect(await SCHEMA_TOOL.run({}, context())).toEqual(stored('mcp-schema/v1-no-database.json'));
  });

  it('passes on what the command said when it failed, and when it ran out of time', async () => {
    run.mockResolvedValueOnce({ ...exitedClean, code: 1, stderrTail: 'A module has migrations, but @marmeon/database is not installed\n' });
    expect(await SCHEMA_TOOL.run({}, context())).toEqual({ failure: 'marmeon schema:project failed: A module has migrations, but @marmeon/database is not installed' });
    run.mockResolvedValueOnce({ ...exitedClean, code: 1, timedOut: true });
    expect(await SCHEMA_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('120 seconds') });
  });

  it('lists at most 50 tables when one is unknown', async () => {
    file({ format: 2, tables: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`t${index}`, {}])) });
    const result = (await SCHEMA_TOOL.run({ table: 'none' }, context())) as { failure: string };
    expect(result.failure).toContain('t49');
    expect(result.failure).not.toContain('t50,');
    expect(result.failure).toContain('and 10 more');
  });
});
