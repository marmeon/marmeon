import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application, createApplication, defineModule, EventRegistry, listen, type ModuleDefinition } from '@marmeon/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.restoreAllMocks());

describe('modules:list --json', () => {
  const directory = new URL('./__fixtures__/formats/cli-modules-list/', import.meta.url);

  it('prints one document, format first, equal to the stored file', async () => {
    const { command } = await build({
      providers: [AppProvider],
      listeners: [listen(NoteDeleted, TouchStats as never)],
      modules: [notes, defineModule({ name: 'quiet', providers: [Quiet] })],
    });
    expect(readdirSync(directory)).toEqual(['v1.json']);
    const out = run(command, { json: true });
    const document = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(document)[0]).toBe('format');
    expect(out.endsWith('\n')).toBe(true);
    expect(document).toEqual(JSON.parse(readFileSync(new URL('v1.json', directory), 'utf8')));
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

  it('is in marmeon list', () => {
    expect(marmeon(blank, ['list']).stdout).toContain('modules:list');
  });
});
