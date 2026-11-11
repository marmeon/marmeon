import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application, createApplication, defineConfig, defineModule, env as e, EventRegistry, listen, type ModuleDefinition } from '@marmeon/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marmeon, repo } from './__fixtures__/cli.js';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { ModulesListCommand } from './commands/modules-list.ts';
import { Output } from './output.ts';

const root = '/srv/app';
const env = { NODE_ENV: 'test', APP_KEY: 'k'.repeat(32) };

class NoteCreated {
  readonly #event = true;
  static event = 'notes.created';
}
class NoteDeleted {
  readonly #event = true;
}
class IndexNote {
  static queue = { queue: 'search' };
  static listener = 'notes.index';
  handle(): void {}
}
class TouchStats {
  handle(): void {}
}
class AuditAll {
  handle(): void {}
}
class SetUpAudit {
  register(container: { make: (token: typeof EventRegistry) => EventRegistry }): void {
    container.make(EventRegistry).listen(NoteDeleted, AuditAll as never);
  }
}
class NotesProvider {
  boot(): void {}
}
class AppProvider {
  boot(): void {}
}
class PruneNotes {
  static command = 'notes:prune';
}
class ExportNotes {
  static job = 'notes.export';
}
class NoteShared {
  static notification = 'notes.shared';
}
class NoteSeeder {}
class Quiet {
  boot(): void {}
}

const notes = defineModule({
  name: 'notes',
  providers: [NotesProvider, SetUpAudit],
  listeners: [listen(NoteCreated, IndexNote as never), listen(NoteCreated, TouchStats)],
  ...({ commands: [PruneNotes], jobs: [ExportNotes], notifications: [NoteShared], seeders: [NoteSeeder], migrations: pathToFileURL('/srv/app/modules/notes/migrations/') } as object),
});

async function build(definition: { modules?: ModuleDefinition[]; providers?: unknown[]; listeners?: unknown[] }): Promise<{ app: Application; command: ModulesListCommand }> {
  const app = await createApplication({ root, discover: false, ...definition } as never, { env, phase: 'build' });
  return { app, command: new ModulesListCommand(app, app.container.make(EventRegistry)) };
}

function run(command: ModulesListCommand, options: Record<string, boolean> = {}): string {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
    lines.push(String(text));
    return true;
  });
  command.handle({ args: [], options, output: new Output(), root } as never);
  return lines.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('modules:list --json', () => {
  const directory = new URL('./__fixtures__/formats/cli-modules-list/', import.meta.url);

  it('prints one document, format first, equal to the stored file', async () => {
    const { command } = await build({
      providers: [AppProvider],
      listeners: [listen(NoteDeleted, TouchStats as never)],
      modules: [notes, defineModule({ name: 'quiet', providers: [Quiet] })],
    });
    expect(readdirSync(directory)).toEqual(['v1-environment.json', 'v1.json']);
    const out = run(command, { json: true });
    const document = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(document)[0]).toBe('format');
    expect(out.endsWith('\n')).toBe(true);
    // The first stored file predates `environment`; the second has it. Whether a variable is set depends on the machine.
    const { environment, ...rest } = document;
    expect(rest).toEqual(JSON.parse(readFileSync(new URL('v1.json', directory), 'utf8')));
    const withoutSet = (entries: Record<string, unknown>[]) => entries.map(({ set: _set, ...entry }) => entry);
    const stored = JSON.parse(readFileSync(new URL('v1-environment.json', directory), 'utf8')) as typeof document & { environment: Record<string, unknown>[] };
    expect({ ...rest, environment: withoutSet(environment as Record<string, unknown>[]) }).toEqual({ ...stored, environment: withoutSet(stored.environment) });
    expect((document.environment as { set: unknown }[]).every((entry) => typeof entry.set === 'boolean')).toBe(true);
  });

  it('names an anonymous listener, a static event that is no string and a migrations folder outside the root', async () => {
    class Odd {
      static event = 42;
    }
    const outside = defineModule({ name: 'outside', listeners: [listen(Odd, (() => {}) as never)], ...({ migrations: pathToFileURL('/elsewhere/migrations/') } as object) });
    const { command } = await build({ modules: [outside] });
    const document = JSON.parse(run(command, { json: true })) as { modules: { migrations: unknown }[]; events: { name: unknown; listeners: { listener: string }[] }[] };
    expect(document.events[0]!.listeners[0]!.listener).toBe('(anonymous)');
    expect(document.events[0]!.name).toBeNull();
    expect(document.modules[0]!.migrations).toBeNull();
    expect((document as unknown as { warnings: string[] }).warnings).toEqual(['outside: its migrations folder lies outside the app root']);
  });

  it('treats a link inside the app that leads out of it as outside, and a folder it cannot resolve too', async () => {
    const base = realpathSync(tempDir('marmeon-modules-list-link-'));
    const appRoot = join(base, 'app');
    mkdirSync(join(appRoot, 'modules'), { recursive: true });
    mkdirSync(join(base, 'elsewhere'));
    symlinkSync(join(base, 'elsewhere'), join(appRoot, 'modules/linked'), 'dir');
    symlinkSync(join(base, 'missing'), join(appRoot, 'modules/dangling'), 'dir');
    mkdirSync(join(appRoot, 'modules/own'));
    const modules = [
      defineModule({ name: 'linked', ...({ migrations: 'modules/linked' } as object) }),
      defineModule({ name: 'dangling', ...({ migrations: 'modules/dangling' } as object) }),
      defineModule({ name: 'own', ...({ migrations: 'modules/own' } as object) }),
      defineModule({ name: 'later', ...({ migrations: 'modules/not-yet' } as object) }),
    ];
    const app = await createApplication({ root: appRoot, discover: false, modules } as never, { env, phase: 'build' });
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (lines.push(String(text)), true));
    new ModulesListCommand(app, app.container.make(EventRegistry)).handle({ args: [], options: { json: true }, output: new Output(), root: appRoot } as never);
    const document = JSON.parse(lines.join('')) as { modules: { name: string; migrations: string | null }[]; warnings: string[] };
    expect(document.modules.map((module) => [module.name, module.migrations])).toEqual([['linked', null], ['dangling', null], ['own', 'modules/own'], ['later', 'modules/not-yet']]);
    expect(document.warnings).toEqual(['linked: its migrations folder lies outside the app root', 'dangling: its migrations folder lies outside the app root']);
  });

  it('warns for no module that simply has no migrations folder', async () => {
    const { command } = await build({ modules: [defineModule({ name: 'plain' })] });
    expect((JSON.parse(run(command, { json: true })) as { warnings: string[] }).warnings).toEqual([]);
  });

  it('prints the name of a provider or seeder class and nothing the class holds', async () => {
    const token = ['tok', 'en', '51ab9f'].join('-');
    class Holder {
      static defaults = { token };
      boot(): void {}
    }
    class HeldSeeder {
      static defaults = { token };
    }
    const { command } = await build({ modules: [defineModule({ name: 'held', providers: [Holder], ...({ seeders: [HeldSeeder] } as object) })] });
    const out = run(command, { json: true });
    expect(out).not.toContain(token);
    expect(JSON.parse(out)).toMatchObject({ modules: [{ providers: ['Holder'], seeders: ['HeldSeeder'] }] });
    // A spread of the class would carry the token: the assertion above can fail.
    expect(JSON.stringify({ ...Holder })).toContain(token);
  });

  it('lists the keys of a module exactly, and none of the fields it does not print', async () => {
    const { command } = await build({ modules: [defineModule({ name: 'x', ...({ secretish: 'plain-value-1', csrfExcept: ['/hook'], exposes: { a: 1 } } as object) })] });
    const out = run(command, { json: true });
    const document = JSON.parse(out) as { modules: object[] };
    expect(Object.keys(document.modules[0]!)).toEqual(['name', 'providers', 'commands', 'jobs', 'notifications', 'seeders', 'migrations']);
    expect(out).not.toContain('plain-value-1');
    expect(out).not.toContain('/hook');
  });
});

describe('modules:list environment', () => {
  // Joined at run time: a token-shaped literal in the source would trip the secret scan of a push.
  const canary = ['canary', 'sk', 'live', 'abcdefgh12345678'].join('-');
  const fallback = ['dflt', 'value', '7f3a9c'].join('-');

  const Mail = defineConfig('mail', {
    env: e({ MAIL_TOKEN: e.string(), MAIL_FROM: e.string().default(fallback), MAIL_REPLY: e.string().optional() }),
    resolve: (values) => values,
  });
  const Billing = defineConfig('billing', { env: e({ BILLING_KEY: e.string() }), resolve: (values) => values });

  const environmentOf = async (definition: Parameters<typeof build>[0], appRoot = root) => {
    const { command } = await build(definition);
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (lines.push(String(text)), true));
    command.handle({ args: [], options: { json: true }, output: new Output(), root: appRoot } as never);
    return JSON.parse(lines.join('')) as { environment: Record<string, unknown>[]; warnings: string[] };
  };
  // The tests count on these being absent, whatever the shell that runs them exports.
  beforeEach(() => {
    for (const name of ['MAIL_TOKEN', 'MAIL_FROM', 'MAIL_REPLY', 'BILLING_KEY']) vi.stubEnv(name, undefined);
  });
  const custom = { name: 'owned', env: { '~standard': { version: 1, vendor: 'other', validate: (value: unknown) => ({ value }) } }, resolve: () => ({}) };

  it('names each variable with its state, sorted, and the core\'s own', async () => {
    vi.stubEnv('MAIL_TOKEN', canary);
    const { environment, warnings } = await environmentOf({ modules: [defineModule({ name: 'mailer', ...({ config: [Mail] } as object) })], ...({ config: [Billing] } as object) });
    const mine = environment.filter((entry) => ['MAIL_TOKEN', 'MAIL_FROM', 'MAIL_REPLY', 'BILLING_KEY'].includes(entry.name as string));
    expect(mine).toEqual([
      { name: 'BILLING_KEY', config: 'billing', modules: [], set: false, required: true, hasDefault: false },
      { name: 'MAIL_FROM', config: 'mail', modules: ['mailer'], set: false, required: false, hasDefault: true },
      { name: 'MAIL_REPLY', config: 'mail', modules: ['mailer'], set: false, required: false, hasDefault: false },
      { name: 'MAIL_TOKEN', config: 'mail', modules: ['mailer'], set: true, required: true, hasDefault: false },
    ]);
    expect(environment.map((entry) => entry.name)).toEqual(environment.map((entry) => entry.name).sort());
    expect(environment.some((entry) => entry.name === 'NODE_ENV')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('lists a configuration shared by two modules under both', async () => {
    const { environment } = await environmentOf({ modules: [defineModule({ name: 'one', ...({ config: [Mail] } as object) }), defineModule({ name: 'two', ...({ config: [Mail] } as object) })] });
    expect(environment.find((entry) => entry.name === 'MAIL_TOKEN')?.modules).toEqual(['one', 'two']);
  });

  it('counts an empty variable as not set, and reads the app\'s .env', async () => {
    const appRoot = realpathSync(tempDir('marmeon-modules-list-env-'));
    writeFileSync(join(appRoot, '.env'), 'MAIL_TOKEN=\nMAIL_REPLY=somebody\n');
    const { environment } = await environmentOf({ modules: [defineModule({ name: 'mailer', ...({ config: [Mail] } as object) })] }, appRoot);
    const set = Object.fromEntries(environment.map((entry) => [entry.name, entry.set]));
    expect(set).toMatchObject({ MAIL_TOKEN: false, MAIL_REPLY: true });
  });

  it('shows no value, no default and nothing derived from one', async () => {
    const appRoot = realpathSync(tempDir('marmeon-modules-list-env-'));
    writeFileSync(join(appRoot, '.env'), `MAIL_REPLY=${canary}\n`);
    vi.stubEnv('MAIL_TOKEN', canary);
    vi.stubEnv('MAIL_FROM', `${canary}-from`);
    const { command } = await build({ modules: [defineModule({ name: 'mailer', ...({ config: [Mail] } as object) })] });
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (lines.push(String(text)), true));
    command.handle({ args: [], options: { json: true }, output: new Output(), root: appRoot } as never);
    const out = lines.join('');
    for (const needle of [canary, fallback, String(canary.length)]) expect(out).not.toContain(needle);
    const entry = (JSON.parse(out) as { environment: Record<string, unknown>[] }).environment.find((item) => item.name === 'MAIL_FROM')!;
    expect(Object.keys(entry)).toEqual(['name', 'config', 'modules', 'set', 'required', 'hasDefault']);
    expect(entry).toMatchObject({ set: true, hasDefault: true });
    // The text output says nothing of the variables.
    lines.length = 0;
    command.handle({ args: [], options: {}, output: new Output(), root: appRoot } as never);
    expect(lines.join('')).not.toContain('MAIL_TOKEN');
  });

  it('warns for a configuration that validates with a schema of its own, and lists none of its variables', async () => {
    const { environment, warnings } = await environmentOf({ ...({ config: [custom] } as object) });
    expect(warnings).toEqual(['config owned validates its environment with its own schema; its variables are not listed']);
    expect(environment.every((entry) => entry.config !== 'owned')).toBe(true);
  });

  it('prints nothing of the variables in text mode, not even the warning for a schema of its own', async () => {
    const { command } = await build({ ...({ config: [custom, Mail] } as object) });
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (lines.push(String(text)), true));
    command.handle({ args: [], options: {}, output: new Output(), root } as never);
    expect(stderr).not.toHaveBeenCalled();
    expect(lines.join('')).not.toMatch(/owned|MAIL_|environment/);
  });

  it('does not count a name from the prototype of the environment as set', async () => {
    const odd = { name: 'odd', env: { [Symbol.for('marmeon.env.fields')]: { toString: { '~env': () => ({ value: 1 }) }, constructor: { '~env': () => ({ value: 1 }) }, ['__proto__']: { '~env': () => ({ value: 1 }) } }, '~standard': { version: 1, vendor: 'x', validate: () => ({ value: {} }) } }, resolve: () => ({}) };
    const { environment } = await environmentOf({ ...({ config: [odd] } as object) });
    const mine = environment.filter((entry) => entry.config === 'odd');
    expect(mine.map((entry) => entry.name).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(mine.every((entry) => entry.set === false)).toBe(true);
  });

  it('warns for a variable whose reader throws, and carries on', async () => {
    const broken = { name: 'broken', env: { [Symbol.for('marmeon.env.fields')]: { BROKEN: { '~env': () => { throw new Error(canary); } } }, '~standard': { version: 1, vendor: 'x', validate: () => ({ value: {} }) } }, resolve: () => ({}) };
    const { environment, warnings } = await environmentOf({ ...({ config: [broken] } as object) });
    expect(warnings).toEqual(['config broken: BROKEN could not be inspected']);
    expect(environment.some((entry) => entry.name === 'BROKEN')).toBe(false);
  });
});

describe('modules:list as text', () => {
  it('prints a block per module and the listeners of each event, leaving empty parts out', async () => {
    const { command } = await build({ modules: [notes, defineModule({ name: 'quiet' })] });
    const out = run(command);
    expect(out).toContain('notes\n  providers: NotesProvider, SetUpAudit\n  commands: notes:prune\n  jobs: ExportNotes (notes.export)');
    expect(out).toContain('  migrations: modules/notes/migrations');
    expect(out).toContain('quiet\n');
    expect(out).not.toMatch(/quiet\n {2}providers/);
    expect(out).toContain('NoteCreated → IndexNote (queued)');
    expect(out).toContain('NoteDeleted → AuditAll');
  });

  it('starts with the providers of the app', async () => {
    const { command } = await build({ providers: [AppProvider], modules: [notes] });
    expect(run(command)).toMatch(/^App providers: AppProvider\n\nnotes\n/);
  });

  it('points to make:module when there is none', async () => {
    const { command } = await build({});
    expect(run(command)).toContain('make:module');
  });
});

describe('marmeon modules:list in an app', { timeout: 60_000 }, () => {
  const blank = join(repo, 'apps/blank-app');
  // Joined at run time: a token-shaped literal in the source would trip the secret scan of a push.
  const secret = ['sk', 'live', 'abcdefgh12345678'].join('_');
  const configDefault = ['dflt', 'value', '7f3a9c'].join('-');

  function secretApp(): string {
    const app = realpathSync(tempDir('marmeon-modules-list-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    writeFileSync(join(app, '.env'), `${readFileSync(join(blank, '.env.example'), 'utf8')}\nAPP_KEY=${'a'.repeat(32)}\nMAIL_SECRET=${secret}\n`);
    writeFileSync(
      join(app, 'modules/system/index.ts'),
      [
        "import { defineConfig, defineModule, env } from '@marmeon/core';",
        `const Hidden = defineConfig('hidden', { env: env({ MAIL_SECRET: env.string() }), resolve: (e) => ({ token: e.MAIL_SECRET, fallback: '${configDefault}' }) });`,
        'class Exploding {',
        "  boot(): void { throw new Error('a provider booted'); }",
        '}',
        `export default defineModule({ name: 'system', providers: [Exploding], config: [Hidden], migrations: new URL('./migrations/', import.meta.url), ...({ secretish: '${secret}' } as object) });`,
        '',
      ].join('\n'),
    );
    return app;
  }

  it('prints no value of the configuration, the .env or an unknown key, and boots no provider', () => {
    const app = secretApp();
    const result = marmeon(app, ['modules:list', '--json']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0); // boot() throws: nothing booted
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(configDefault);
    const document = JSON.parse(result.stdout) as { modules: { name: string; providers: string[]; migrations: string }[] };
    expect(document.modules[0]).toMatchObject({ name: 'system', providers: ['Exploding'], migrations: 'modules/system/migrations' });
    expect(marmeon(app, ['modules:list']).stdout).not.toContain(secret);
  });

  it('names the variable of the configuration as set, and its value nowhere', () => {
    const app = secretApp();
    const result = marmeon(app, ['modules:list', '--json'], { MAIL_SECRET: `${secret}-process` });
    expect(result.stdout).not.toContain(secret);
    const document = JSON.parse(result.stdout) as { environment: Record<string, unknown>[] };
    expect(document.environment).toContainEqual({ name: 'MAIL_SECRET', config: 'hidden', modules: ['system'], set: true, required: true, hasDefault: false });
  });

  it('is in marmeon list', () => {
    expect(marmeon(blank, ['list']).stdout).toContain('modules:list');
  });
});
