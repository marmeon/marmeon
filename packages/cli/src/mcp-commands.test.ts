import { realpathSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { initialize, mcpApp, mcpEnv, mcpSession, type McpSession } from './__fixtures__/mcp.ts';

const run = vi.hoisted(() => vi.fn());
// Only the tool this file runs in its own process uses the stand-in; the server below is a child process with the real one.
vi.mock('./spawn.ts', () => ({ runMarmeonJson: run }));

const { COMMANDS_TOOL } = await import('./mcp/commands.ts');

const call = async (session: McpSession, args: Record<string, unknown>) => (await session.request('tools/call', { name: 'commands', arguments: args })).result;

describe('commands in an app', { timeout: 120_000 }, () => {
  let session: McpSession;

  beforeAll(async () => {
    session = mcpSession(mcpApp(), mcpEnv({ NODE_ENV: 'development' }));
    await initialize(session);
  });
  afterAll(() => session.close());

  it('lists the generators with their options', async () => {
    const result = await call(session, { name: 'make:' });
    expect(result.isError).toBeUndefined();
    const document = result.structuredContent;
    expect(Object.keys(document)[0]).toBe('format');
    expect(Object.keys(document).sort()).toEqual(['commands', 'complete', 'format', 'total', 'truncated', 'warnings']);
    expect(document).toMatchObject({ format: 1, complete: true, truncated: false, warnings: [] });
    const names = document.commands.map((command: { name: string }) => command.name);
    expect(names).toContain('make:controller');
    for (const name of names) expect(name.startsWith('make:')).toBe(true);
    expect(document.total).toBe(names.length);
    for (const command of document.commands) {
      expect(Object.keys(command).sort()).toEqual(['description', 'experimental', 'launcher', 'name', 'options', 'usage']);
      for (const option of command.options) expect(Object.keys(option).sort()).toEqual(['default', 'multiple', 'name', 'short', 'type']);
    }
    expect(JSON.parse(result.content[0].text)).toEqual(document);
  });

  it.each([
    ['a space', { name: 'make controller' }],
    ['a leading dash', { name: '--help' }],
    ['a line break', { name: 'make:\nmigrate' }],
    ['upper case', { name: 'Make' }],
    ['101 characters', { name: 'a'.repeat(101) }],
    ['a limit of 0', { limit: 0 }],
    ['a limit above 500', { limit: 501 }],
    ['a key the schema does not know', { args: ['x'] }],
  ])('refuses %s', async (_reason, input) => {
    const result = await call(session, input as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/validation/i);
  });
});

describe('commands with the child process replaced', () => {
  let root: string;
  const context = () => ({ root, signal: new AbortController().signal });
  const exitedClean = { code: 0, document: undefined, stderrTail: '', timedOut: false, tooLarge: false };
  const answer = (document: unknown) => run.mockResolvedValueOnce({ ...exitedClean, document });
  const option = { name: 'view', type: 'boolean', short: null, multiple: false, default: null };
  const command = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} does it`, usage: null, options: [option], experimental: false, launcher: false, ...extra });
  const listed = { format: 1, complete: true, commands: [command('db:show'), command('make:controller'), command('make:job'), command('migrate'), command('make:model')], warnings: [] };

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mcp-commands-stub-'));
    run.mockReset();
    run.mockResolvedValue(exitedClean);
  });

  it('starts exactly the fixed command, whatever the input says', async () => {
    answer(listed);
    await COMMANDS_TOOL.run({ name: 'make:', limit: 3 }, context());
    expect(run).toHaveBeenLastCalledWith(root, ['list', '--json'], expect.objectContaining({ timeoutMs: 120_000 }));
  });

  it('filters by the prefix and cuts at the limit, saying how many there are', async () => {
    answer(listed);
    const result = (await COMMANDS_TOOL.run({ name: 'make:', limit: 2 }, context())) as unknown as { commands: { name: string }[] };
    expect(result).toMatchObject({ format: 1, complete: true, total: 3, truncated: true, warnings: [] });
    expect(result.commands.map((entry) => entry.name)).toEqual(['make:controller', 'make:job']);
    answer(listed);
    expect(await COMMANDS_TOOL.run({}, context())).toMatchObject({ total: 5, truncated: false });
  });

  it('does not pass on a key a command or an option carries besides the known ones', async () => {
    answer({ ...listed, secret: 'x', commands: [command('make:job', { password: 'y', options: [{ ...option, token: 'z', default: [{ a: 1 }] }] })] });
    const result = await COMMANDS_TOOL.run({}, context());
    expect(result).toMatchObject({ commands: [command('make:job')] });
    const text = JSON.stringify(result);
    for (const leak of ['secret', 'password', 'token', '"x"', '"y"', '"z"']) expect(text).not.toContain(leak);
  });

  it('masks a default that holds a secret, and copies array defaults', async () => {
    // Joined at run time so no token-shaped literal sits in the file.
    const token = ['gh', 'p_', 'a'.repeat(36)].join('');
    answer({ ...listed, commands: [command('x', { options: [{ ...option, default: `Bearer ${token}` }, { ...option, default: ['plain', `TOKEN=${token}`] }, { ...option, default: [true, false] }, { ...option, default: [1, 'a'] }, { ...option, default: 3 }] })] });
    const result = (await COMMANDS_TOOL.run({}, context())) as unknown as { commands: { options: { default: unknown }[] }[] };
    const defaults = result.commands[0]!.options.map((entry) => entry.default);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(defaults[2]).toEqual([true, false]);
    expect(defaults[3]).toBeNull();
    expect(defaults[4]).toBe(3);
    expect(defaults[1]).toEqual(['plain', expect.any(String)]);
  });

  it('passes on `complete: false`, with the first line of each warning, masked and cut', async () => {
    answer({ ...listed, complete: false, warnings: ['The app did not load: boom\n    at stack line', `${'w'.repeat(500)}`, 'DB_PASSWORD=hunter2 is wrong', 7] });
    const result = (await COMMANDS_TOOL.run({}, context())) as unknown as { complete: boolean; warnings: string[] };
    expect(result.complete).toBe(false);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toBe('The app did not load: boom');
    expect(result.warnings[1]).toHaveLength(300);
    expect(result.warnings[2]).not.toContain('hunter2');
  });

  it('accepts the names of commands and refuses the ones that look like options or contain spaces', () => {
    const { pattern } = (COMMANDS_TOOL.inputSchema.properties as Record<string, { pattern: string }>).name!;
    for (const name of ['make:', 'db:show', 'migrate', 'a', 'x'.repeat(100)]) expect(new RegExp(pattern).test(name), name).toBe(true);
    for (const name of ['--force', '-x', ':make', '1a', 'a b', 'a\nb', 'Make', 'x'.repeat(101)]) expect(new RegExp(pattern).test(name), name).toBe(false);
  });

  it('refuses a document of another format, and a command or option it cannot read', async () => {
    answer({ ...listed, format: 2 });
    expect(await COMMANDS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
    answer({ ...listed, commands: [{ name: 'x' }] });
    expect(await COMMANDS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
    answer({ ...listed, commands: [command('x', { options: [{ name: 'a' }] })] });
    expect(await COMMANDS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
  });

  it('passes on the end of stderr when the command fails, and says when it ran out of time', async () => {
    run.mockResolvedValueOnce({ ...exitedClean, code: 1, stderrTail: 'boom\n' });
    expect(await COMMANDS_TOOL.run({}, context())).toEqual({ failure: 'marmeon list failed: boom. Run it in a terminal to see the whole message.' });
    run.mockResolvedValueOnce({ ...exitedClean, code: 1, timedOut: true });
    expect(await COMMANDS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('120 seconds') });
  });

  it('says when the call was cancelled, and when the document was too large', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    run.mockResolvedValueOnce({ ...exitedClean, code: 1 });
    expect(await COMMANDS_TOOL.run({}, { root, signal: cancelled.signal })).toEqual({ failure: expect.stringContaining('cancelled') });
    run.mockResolvedValueOnce({ ...exitedClean, tooLarge: true });
    expect(await COMMANDS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('16 MiB') });
  });

  it('says that something wrote to stdout when the command exits 0 without one document', async () => {
    expect(await COMMANDS_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('did not print one JSON document') });
  });
});
