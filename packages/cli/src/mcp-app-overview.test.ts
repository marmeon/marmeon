import { existsSync, readFileSync, realpathSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { initialize, mcpApp, mcpEnv, mcpSession, type McpSession } from './__fixtures__/mcp.ts';

const run = vi.hoisted(() => vi.fn());
// Only the tool this file runs in its own process uses the stand-in; the servers below are child processes with the real one.
vi.mock('./spawn.ts', () => ({ runMarmeonJson: run }));

const { APP_OVERVIEW_TOOL } = await import('./mcp/app-overview.ts');

const formats = new URL('./__fixtures__/formats/', import.meta.url);
const stored = (path: string) => JSON.parse(readFileSync(new URL(path, formats), 'utf8'));
const call = async (session: McpSession, args: Record<string, unknown>) => (await session.request('tools/call', { name: 'app_overview', arguments: args })).result;

// Assembled at run time: a literal secret in the source would be one for the push protection too.
const SECRET = ['s3cr', '3t-value-', '41'].join('');
// A default is no secret, but it is a value all the same: it must not appear either.
const DEFAULT_PORT = ['d3fa', 'ult-', '7731'].join('');

/** The system module of the app with a listener, a schedule and a key the overview must not know, which holds the secret. */
function describeModule(app: string, schedule = "s.command('cache:prune').hourly().description('Prunes the cache');"): void {
  const file = join(app, 'modules/system/index.ts');
  const source = readFileSync(file, 'utf8')
    .replace("import { defineModule } from '@marmeon/core';", [
      "import { defineConfig, defineModule, env, listen } from '@marmeon/core';",
      `const Overview = defineConfig('overview', { env: env({ OVERVIEW_SECRET: env.string(), OVERVIEW_PORT: env.string().default(${JSON.stringify(DEFAULT_PORT)}), OVERVIEW_NOTE: env.string().optional() }), resolve: (values) => values });`,
      "import { defineSchedule } from '@marmeon/scheduler';",
      "class NoteCreated { readonly #event = true; static event = 'notes.created'; }",
      'class IndexNote { handle() {} }',
      `const schedule = defineSchedule((s) => { ${schedule} });`,
    ].join('\n'))
    .replace("name: 'system',", `name: 'system', schedule, config: [Overview], listeners: [listen(NoteCreated, IndexNote)], secretish: ${JSON.stringify(SECRET)},`);
  writeFileSync(file, source);
  appendFileSync(join(app, '.env'), `OVERVIEW_SECRET=${SECRET}\n`);
}

describe('app_overview in an app', { timeout: 120_000 }, () => {
  let app: string;
  let session: McpSession;
  let bootLog: string;
  const boots = () => (existsSync(bootLog) ? readFileSync(bootLog, 'utf8').split('\n').filter(Boolean).length : 0);

  beforeAll(async () => {
    app = mcpApp();
    describeModule(app);
    bootLog = join(realpathSync(tempDir('marmeon-mcp-overview-boots-')), 'boots.log');
    session = mcpSession(app, mcpEnv({ NODE_ENV: 'development', MCP_BOOT_LOG: bootLog, OVERVIEW_SECRET: SECRET }));
    await initialize(session);
  });
  afterAll(() => session.close());

  it('lists the modules, the events and the schedules, with the format first and the same document as text', async () => {
    const before = boots();
    const result = await call(session, {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject(stored('mcp-app-overview/v1.json'));
    expect(Object.keys(result.structuredContent)[0]).toBe('format');
    expect(result.structuredContent.packages).toEqual(expect.arrayContaining(['@marmeon/scheduler']));
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    // modules:list and schedule:list each start the app.
    expect(boots()).toBe(before + 2);
  });

  it('gives one module and the events it listens to, and starts the app once', async () => {
    const before = boots();
    const result = await call(session, { module: 'system' });
    expect(result.structuredContent).toMatchObject(stored('mcp-app-overview/v1-module.json'));
    expect(result.structuredContent).toMatchObject(stored('mcp-app-overview/v1-environment.json'));
    expect(result.structuredContent.schedules).toBeNull();
    expect(boots()).toBe(before + 1);
  });

  it('names the runtime of the server process', async () => {
    const { runtime } = (await call(session, {})).structuredContent;
    expect(Object.keys(runtime)).toEqual(['node', 'platform', 'arch', 'marmeon', 'nodeEnv']);
    expect(runtime).toMatchObject({ node: process.version, platform: process.platform, arch: process.arch, nodeEnv: 'development' });
    expect(runtime.marmeon).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('names the variables with their state, those of the module only when one is asked for', async () => {
    const all = (await call(session, {})).structuredContent.environment as Record<string, unknown>[];
    // The packages of the app bring their own variables; the module's are among them.
    expect(all.length).toBeGreaterThan(3);
    expect(all).toContainEqual({ name: 'OVERVIEW_SECRET', config: 'overview', set: true, required: true, hasDefault: false });
    expect(all).toContainEqual({ name: 'OVERVIEW_PORT', config: 'overview', set: false, required: false, hasDefault: true });
    expect(all.every((item) => Object.keys(item).join() === 'name,config,set,required,hasDefault')).toBe(true);
    expect(all.map((item) => item.name)).toEqual([...all.map((item) => item.name)].sort());
    const own = (await call(session, { module: 'system' })).structuredContent.environment as { name: string }[];
    expect(own.map((item) => item.name)).toEqual(['OVERVIEW_NOTE', 'OVERVIEW_PORT', 'OVERVIEW_SECRET']);
  });

  it('names the modules when the one asked for is unknown', async () => {
    const result = await call(session, { module: 'nothing' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('No module named nothing. Modules: system.');
  });

  it('shows no value of the module, the configuration or the .env', async () => {
    for (const input of [{}, { module: 'system' }]) {
      const result = await call(session, input);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain(DEFAULT_PORT);
      expect(JSON.stringify(result)).not.toContain('secretish');
      expect(Object.keys(result.structuredContent.modules[0]).sort()).toEqual(['commands', 'jobs', 'migrations', 'name', 'notifications', 'providers', 'seeders']);
    }
  });

  // Argument injection: the input is checked before any child process starts (the app records each boot).
  it.each([
    ['an option as the module', { module: '--json' }],
    ['a module with a newline', { module: 'system\n--force' }],
    ['a key the schema does not know', { filter: 'x' }],
    ['a module that is not a string', { module: 1 }],
  ])('refuses %s and starts nothing', async (_reason, input) => {
    const before = boots();
    const result = await call(session, input as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/validation/i);
    expect(boots()).toBe(before);
  });
});

describe('app_overview when the schedule cannot be read', { timeout: 120_000 }, () => {
  it('answers with the rest and a warning that carries no password', async () => {
    const app = mcpApp();
    const password = ['hunter', '2', 'pw'].join('');
    describeModule(app, `throw new Error('no cache: CACHE_URL=redis://app:${password}@127.0.0.1:1 password=${password}');`);
    const session = mcpSession(app, mcpEnv({ NODE_ENV: 'development' }));
    try {
      await initialize(session);
      const result = await call(session, {});
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.schedules).toBeNull();
      expect(result.structuredContent.modules.map((item: { name: string }) => item.name)).toEqual(['system']);
      expect(result.structuredContent.warnings).toEqual([expect.stringContaining('marmeon schedule:list failed')]);
      expect(JSON.stringify(result)).not.toContain(password);
    } finally {
      await session.close();
    }
  });
});

describe('app_overview when the app fails to start', { timeout: 120_000 }, () => {
  it('is an error that carries no password from the message of the failure', async () => {
    const app = mcpApp();
    const password = ['hunter', '2', 'pw'].join('');
    const module = join(app, 'modules/system/index.ts');
    writeFileSync(module, `throw new Error('connection failed: DB_URL=postgres://app:${password}@127.0.0.1:1/app password=${password}');\n${readFileSync(module, 'utf8')}`);
    const session = mcpSession(app, mcpEnv({ NODE_ENV: 'development' }));
    try {
      await initialize(session);
      const result = await call(session, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('marmeon modules:list failed:');
      expect(result.content[0].text).toContain('connection failed');
      expect(result.content[0].text).not.toContain(password);
    } finally {
      await session.close();
    }
  });
});

describe('app_overview with the child process replaced', () => {
  let root: string;
  const context = () => ({ root, signal: new AbortController().signal });
  const exitedClean = { code: 0, document: undefined, stderrTail: '', timedOut: false, tooLarge: false };
  const answer = (over: Record<string, unknown>) => run.mockResolvedValueOnce({ ...exitedClean, ...over });
  const withScheduler = () => {
    mkdirSync(join(root, 'node_modules/@marmeon/scheduler'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@marmeon/scheduler/package.json'), '{}');
  };
  const overview = (extra: Record<string, unknown> = {}) => ({
    format: 1,
    packages: ['@marmeon/http'],
    app: { providers: ['AppProvider'] },
    modules: [{ name: 'a', providers: ['P'], commands: [], jobs: [], notifications: [], seeders: [], migrations: null }, { name: 'b', providers: [], commands: [], jobs: [], notifications: [], seeders: [], migrations: null }],
    events: [{ event: 'E', name: null, listeners: [{ listener: 'La', queued: false, defined: 'module', module: 'a' }, { listener: 'Lb', queued: true, defined: 'module', module: 'b' }, { listener: 'Lx', queued: false, defined: 'app', module: null }] }],
    environment: [
      { name: 'A_KEY', config: 'a-config', module: 'a', set: true, required: true, hasDefault: false },
      { name: 'B_KEY', config: 'b-config', module: 'b', set: false, required: false, hasDefault: true },
      { name: 'APP_KEY', config: 'app-config', module: null, set: true, required: true, hasDefault: false },
    ],
    warnings: ['from modules:list'],
    ...extra,
  });
  const tasks = { format: 2, tasks: [{ name: 'n', expression: '* * * * *', timeZone: 'UTC', next: '2099', does: 'call X', description: null, options: {} }], warnings: [] };

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mcp-overview-stub-'));
    run.mockReset();
    run.mockResolvedValue(exitedClean);
  });

  it('starts exactly the fixed commands, one after the other, whatever the input says', async () => {
    withScheduler();
    answer({ document: overview() });
    answer({ document: tasks });
    await APP_OVERVIEW_TOOL.run({}, context());
    expect(run.mock.calls.map((args) => args[1])).toEqual([['modules:list', '--json'], ['schedule:list', '--json']]);

    run.mockClear();
    answer({ document: overview() });
    await APP_OVERVIEW_TOOL.run({ module: 'a' }, context());
    expect(run.mock.calls.map((args) => args[1])).toEqual([['modules:list', '--json']]);
  });

  it('copies known fields and drops every other key, at every level', async () => {
    withScheduler();
    const document = overview({
      leaks: 'top',
      app: { providers: ['AppProvider'], config: 'leaks' },
      modules: [{ name: 'a', providers: ['P'], commands: [], jobs: [{ class: 'J', job: 'j', secret: 'leaks' }], notifications: [], seeders: [], migrations: null, secretish: 'leaks' }],
      environment: [{ name: 'N', config: 'c', module: null, set: true, required: false, hasDefault: false, value: 'leaks', default: 'leaks', length: 5 }],
      events: [{ event: 'E', name: null, extra: 'leaks', listeners: [{ listener: 'L', queued: false, defined: 'app', module: null, extra: 'leaks' }] }],
    });
    answer({ document });
    answer({ document: { ...tasks, tasks: [{ ...tasks.tasks[0], does: 'call Payload{"leaks"}', options: { extra: 'leaks' } }] } });
    const result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('leaks');
    expect(Object.keys(result)).toEqual(['format', 'runtime', 'packages', 'app', 'modules', 'events', 'environment', 'schedules', 'warnings']);
    // The module a variable belongs to only filters; it is not passed on.
    expect(result.environment).toEqual([{ name: 'N', config: 'c', set: true, required: false, hasDefault: false }]);
    expect(result.schedules).toEqual([{ name: 'n', expression: '* * * * *', timeZone: 'UTC', description: null }]);
  });

  it('leaves out the events of other modules, and the schedules, when a module is asked for', async () => {
    answer({ document: overview() });
    const result = (await APP_OVERVIEW_TOOL.run({ module: 'a' }, context())) as Record<string, any>;
    expect(result.modules.map((item: { name: string }) => item.name)).toEqual(['a']);
    expect(result.events).toEqual([{ event: 'E', name: null, listeners: [{ listener: 'La', queued: false, defined: 'module', module: 'a' }] }]);
    expect(result.schedules).toBeNull();
    expect(result.warnings).toEqual(['from modules:list']);
    expect(result.environment).toEqual([{ name: 'A_KEY', config: 'a-config', set: true, required: true, hasDefault: false }]);
  });

  it('lists every variable, sorted as modules:list gave them, without a module filter', async () => {
    answer({ document: overview() });
    const result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, any>;
    expect(result.environment.map((item: { name: string }) => item.name)).toEqual(['A_KEY', 'B_KEY', 'APP_KEY']);
  });

  it('names the runtime of this process', async () => {
    answer({ document: overview() });
    const result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, any>;
    expect(result.runtime).toEqual({ node: process.version, platform: process.platform, arch: process.arch, marmeon: expect.stringMatching(/^\d+\.\d+\.\d+/), nodeEnv: 'development' });
  });

  it('gives each warning as its first line, masked and cut to 300 characters', async () => {
    const password = ['hunter', '2', 'pw'].join('');
    answer({ document: overview({ warnings: [`config x: password=${password}\nsecond line`, 'y'.repeat(400)] }) });
    const result = (await APP_OVERVIEW_TOOL.run({}, context())) as unknown as { warnings: string[] };
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).not.toContain(password);
    expect(result.warnings[0]).not.toContain('second line');
    expect(result.warnings[1]).toHaveLength(300);
  });

  it('refuses a document whose variables are not what this version reads', async () => {
    answer({ document: overview({ environment: [{ name: 'X', config: 'c', module: null, set: 'yes', required: true, hasDefault: false }] }) });
    expect(await APP_OVERVIEW_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
  });

  it('reads a document that has no environment, as the first version of the format printed it', async () => {
    answer({ document: overview({ environment: undefined }) });
    const result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, any>;
    expect(result.environment).toEqual([]);
    expect(result.modules).toHaveLength(2);
  });

  it('has no schedules, and does not look for them, without @marmeon/scheduler', async () => {
    answer({ document: overview() });
    const result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, any>;
    expect(result.schedules).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is an error when modules:list fails, with the redacted end of stderr', async () => {
    answer({ code: 1, stderrTail: 'boom\n' });
    expect(await APP_OVERVIEW_TOOL.run({}, context())).toEqual({ failure: 'marmeon modules:list failed: boom. Run it in a terminal to see the whole message.' });
    answer({ timedOut: true });
    expect(await APP_OVERVIEW_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('120 seconds') });
    answer({});
    expect(await APP_OVERVIEW_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('did not print one JSON document') });
  });

  it('refuses a document of another format or shape', async () => {
    answer({ document: overview({ format: 2 }) });
    expect(await APP_OVERVIEW_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
    answer({ document: overview({ modules: [{ name: 'a' }] }) });
    expect(await APP_OVERVIEW_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
    answer({ document: overview({ events: [{ event: 'E', name: null, listeners: [{ listener: 'L', queued: 'yes', defined: 'app', module: null }] }] }) });
    expect(await APP_OVERVIEW_TOOL.run({}, context())).toEqual({ failure: expect.stringContaining('update marmeon') });
  });

  it('answers with schedules null and a warning when schedule:list fails, is of another format, or prints nothing', async () => {
    withScheduler();
    answer({ document: overview() });
    answer({ code: 1, stderrTail: 'first line\nsecond line\n' });
    let result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, any>;
    expect(result.schedules).toBeNull();
    expect(result.modules).toHaveLength(2);
    expect(result.warnings).toEqual(['from modules:list', 'The schedules are missing: marmeon schedule:list failed: first line']);

    answer({ document: overview() });
    answer({ document: { ...tasks, format: 3 } });
    result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, any>;
    expect(result.schedules).toBeNull();
    expect(result.warnings[1]).toContain('update marmeon');

    answer({ document: overview() });
    answer({});
    result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, any>;
    expect(result.schedules).toBeNull();
    expect(result.warnings[1]).toContain('did not print one JSON document');
  });

  it('answers with schedules null and a fixed warning when schedule:list cannot be started', async () => {
    withScheduler();
    answer({ document: overview() });
    run.mockRejectedValueOnce(new Error('spawn EAGAIN at /private/path'));
    const result = (await APP_OVERVIEW_TOOL.run({}, context())) as Record<string, any>;
    expect(result.schedules).toBeNull();
    expect(result.modules).toHaveLength(2);
    expect(result.warnings).toEqual(['from modules:list', 'The schedules are missing: marmeon schedule:list failed: it could not be started']);
  });

  it('names at most twenty modules when the one asked for is unknown', async () => {
    answer({ document: overview({ modules: Array.from({ length: 25 }, (_, index) => ({ name: `m${index}`, providers: [], commands: [], jobs: [], notifications: [], seeders: [], migrations: null })) }) });
    const result = (await APP_OVERVIEW_TOOL.run({ module: 'x' }, context())) as { failure: string };
    expect(result.failure).toContain('m19');
    expect(result.failure).not.toContain('m20');
  });

  it('stops after the first command when the call was cancelled', async () => {
    withScheduler();
    const controller = new AbortController();
    run.mockImplementationOnce(async () => {
      controller.abort();
      return { ...exitedClean, document: overview() };
    });
    expect(await APP_OVERVIEW_TOOL.run({}, { root, signal: controller.signal })).toEqual({ failure: expect.stringContaining('cancelled') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is cancelled, not a warning, when the call is aborted and schedule:list then rejects', async () => {
    withScheduler();
    const controller = new AbortController();
    answer({ document: overview() });
    run.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    expect(await APP_OVERVIEW_TOOL.run({}, { root, signal: controller.signal })).toEqual({ failure: expect.stringContaining('cancelled') });
  });
});
