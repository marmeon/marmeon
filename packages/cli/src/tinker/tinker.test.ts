import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApplication, defineModule, listen, providerJobs, token, type Application, type Key, type ServiceProviderClass } from '@marmeon/core';
import { defineRoutes, Router } from '@marmeon/router';
import { TinkerCommand } from '../commands/tinker.ts';
import { completer, interactive } from './repl.ts';
import { secondCopies, UnreadableTree } from '../check/packages.ts';
import { TinkerSession } from './session.ts';
import { toJavaScript } from './typescript.ts';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

describe('TypeScript input', () => {
  it('strips the types and keeps the rest of the line where it was', () => {
    expect(toJavaScript('const n: number = await count()\n')).toEqual({ code: 'const n         = await count()\n' });
    expect(toJavaScript('interface Point { x: number }')).toEqual({ code: '                             ' });
  });

  it('waits for more lines when the input ends too early, and names TypeScript a transform would need', () => {
    expect(toJavaScript('function double(n: number) {\n')).toHaveProperty('incomplete');
    expect(toJavaScript('enum Role { Admin }')).toEqual({ error: new SyntaxError('TypeScript enum is not supported in strip-only mode') });
  });

  it('reads an object literal as the REPL does, and hands over what it cannot parse as it is', () => {
    expect(toJavaScript('{ a: 1, b: 2 as number }')).toEqual({ code: '({ a: 1, b: 2           })' });
    expect(toJavaScript('{ a: 1 }')).toEqual({ code: '{ a: 1 }' }); // a block with a label — the REPL wraps it itself
    expect(toJavaScript('let 1x = 2')).toEqual({ code: 'let 1x = 2' }); // the REPL's SyntaxError says what is wrong
  });
});

describe('a tinker session (in-process)', () => {
  const Mailer = token<{ send(): string }>('Mailer');
  class ShipOrderJob {
    static job = 'shop.ship-order';
  }
  let root: string;
  let app: Application;

  beforeAll(async () => {
    root = tempDir('marmeon-tinker-');
    // Repositories are found by file name and told apart by shape — without importing @marmeon/database.
    const repository = (name: string, table: string) => `export class ${name} { static table = '${table}'; query() {} find() {} }\n`;
    mkdirSync(join(root, 'modules/shop'), { recursive: true });
    writeFileSync(join(root, 'modules/shop/OrderRepository.ts'), repository('OrderRepository', 'orders'));
    writeFileSync(join(root, 'modules/shop/ArchivedOrderRepository.ts'), repository('ArchivedOrderRepository', 'archive'));
    writeFileSync(join(root, 'modules/shop/OrderReportRepository.ts'), repository('OrderReportRepository', 'archive'));
    mkdirSync(join(root, 'node_modules/vendor'), { recursive: true });
    writeFileSync(join(root, 'node_modules/vendor/VendorRepository.ts'), repository('VendorRepository', 'vendors'));
    const router = new Router().load(defineRoutes((Route) => [Route.get('/orders/:order', () => 'order').name('orders.show'), Route.get('/', () => 'home').name('home')]));
    app = await createApplication({
      root,
      discover: false,
      modules: [defineModule({ name: 'shop', jobs: [ShipOrderJob] })],
    }, { env: {}, override: (container) => container.instance(Router, router).instance(Mailer, { send: () => 'sent' }) });
  });

  it('knows classes and tokens by name — bound ones and those a module lists', () => {
    const tinker = new TinkerSession(app);
    expect(tinker.names()).toEqual(expect.arrayContaining(['Application', 'Mailer', 'Router', 'ShipOrderJob']));
    expect((tinker.make('Mailer') as { send(): string }).send()).toBe('sent');
    expect(() => tinker.make('Mail')).toThrow('No class or token is known by the name "Mail". Did you mean "Mailer"?');
  });

  it('names repositories by table — by class where two share one — and skips node_modules', async () => {
    const tinker = new TinkerSession(app);
    expect(await tinker.repositoryNames()).toEqual(['ArchivedOrderRepository', 'OrderReportRepository', 'orders']);
    expect(tinker.names()).toContain('OrderRepository');
  });

  it('puts the helpers on the context lazily and takes them away again', async () => {
    const tinker = new TinkerSession(app);
    await tinker.open();
    const context: Record<string, unknown> = { url: 'mine', URL };
    tinker.attach(context);
    expect(context.url).toBeTypeOf('function'); // the helper wins over what the context had …
    expect((context.url as (name: string, params?: object) => string)('orders.show', { order: 7 })).toBe('/orders/7');
    expect(context.app).toBe(app);
    expect(context.Mailer).toBe(Mailer); // names are their class or token
    expect(context.URL).toBe(URL); // … a name the context had stays
    expect(Object.getOwnPropertyDescriptor(context, 'db')?.get).toBeTypeOf('function'); // built on first use
    expect(() => context.db).toThrow("db needs @marmeon/database in your app's package.json, installed (marmeon add database, or install your dependencies).");
    context.db = 'replaced'; // like any variable
    expect(context.db).toBe('replaced');
    await tinker.loadRepositories();
    expect(context.OrderRepository).toBeTypeOf('function'); // loaded repositories join the context
    tinker.detach();
    expect(context).toEqual({ url: 'mine', URL });
  });

  it('completes repositories, configuration, route names and class names', async () => {
    const tinker = new TinkerSession(app);
    const complete = completer(tinker, (line, callback) => callback(null, [['(fallback)'], line]));
    const run = (line: string) => new Promise<[string[], string]>((resolve, reject) => complete(line, (error, result) => (error ? reject(error) : resolve(result))));
    expect(await run('await repos.or')).toEqual([['orders'], 'or']);
    expect(await run("url('orders.")).toEqual([['orders.show'], 'orders.']);
    expect(await run('make(Mai')).toEqual([['Mailer'], 'Mai']);
    expect(await run("make('Order")).toEqual([['OrderReportRepository', 'OrderRepository'], 'Order']);
    expect(await run('1 + ')).toEqual([['(fallback)'], '1 + ']);
  });

  it.each([
    ['repos', "repos needs @marmeon/database in your app's package.json, installed (marmeon add database, or install your dependencies)."],
    ['t', 't needs @marmeon/i18n (marmeon add i18n; if it is installed already: marmeon discover).'],
  ])('names the install of the package the helper %s lacks', async (helper, message) => {
    const context: Record<string, unknown> = {};
    const tinker = new TinkerSession(app);
    await tinker.open();
    tinker.attach(context);
    expect(() => context[helper]).toThrow(message);
  });

  it('refuses --sandbox without @marmeon/database, and names the install', async () => {
    await expect(new TinkerSession(app, { sandbox: true }).open()).rejects.toThrow("--sandbox needs @marmeon/database in your app's package.json, installed (marmeon add database, or install your dependencies).");
  });

  describe('the history file', () => {
    const sit = async (history: string | undefined) => {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const tinker = new TinkerSession(app);
      await tinker.open();
      const done = interactive(tinker, { history, input, output });
      input.end("'secret-token'\n.exit\n");
      await done;
    };
    const mode = (file: string) => statSync(file).mode & 0o777;

    it('is owner-only when new, and made owner-only when it exists with wider access', async () => {
      const fresh = join(tempDir('marmeon-tinker-history-'), 'storage/framework/tinker_history');
      await sit(fresh);
      expect(mode(fresh)).toBe(0o600);

      const wide = join(tempDir('marmeon-tinker-history-'), 'tinker_history');
      writeFileSync(wide, 'old\n', { mode: 0o644 });
      chmodSync(wide, 0o644);
      await sit(wide);
      expect(mode(wide)).toBe(0o600);
    });

    it('is left alone by --execute', async () => {
      const root = tempDir('marmeon-tinker-history-');
      const file = join(root, 'storage/framework/tinker_history');
      const output = { line() {}, warn() {}, error() {} } as never;
      const command = new TinkerCommand(app);
      expect(await command.handle({ options: { execute: '1 + 1' }, output, root } as never)).toBe(0);
      expect(existsSync(file)).toBe(false);

      mkdirSync(join(root, 'storage/framework'), { recursive: true });
      writeFileSync(file, 'before\n', { mode: 0o600 });
      expect(await command.handle({ options: { execute: '1 + 1' }, output, root } as never)).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('before\n');
    });
  });
});

describe('the jobs a provider lists in a tinker session', () => {
  /** A job class of this name, as a package brings it. */
  const job = (name: string) => {
    const Job = class {
      static job = `pkg.${name.toLowerCase()}`;
      handle() {}
    };
    Object.defineProperty(Job, 'name', { value: name });
    return Job;
  };
  const providerOf = (jobs: unknown) => class { static [providerJobs] = jobs; boot() {} } as unknown as ServiceProviderClass;
  const repository = (name: string, table: string) => `export class ${name} { static table = '${table}'; query() {} find() {} }\n`;

  async function session(options: { providers?: ServiceProviderClass[]; modules?: ReturnType<typeof defineModule>[]; files?: Record<string, string>; bind?: (container: never) => void; sandbox?: boolean } = {}) {
    const root = tempDir('marmeon-tinker-providers-');
    for (const [file, source] of Object.entries(options.files ?? {})) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    const app = await createApplication({ root, discover: false, providers: options.providers ?? [], modules: options.modules ?? [] }, { env: {}, override: (container) => options.bind?.(container as never) });
    const tinker = new TinkerSession(app, { sandbox: options.sandbox });
    if (!options.sandbox) await tinker.open();
    return { app, tinker };
  }

  it('knows the class by name and nothing else a provider carries', async () => {
    const Listed = job('ListedJob');
    const Provider = class { static [providerJobs] = [Listed]; static notifications = [class Late { static notification = 'x.late'; }]; boot() {} } as unknown as ServiceProviderClass;
    const { tinker } = await session({ providers: [Provider] });
    expect(tinker.names()).toContain('ListedJob');
    expect(tinker.names()).not.toContain('Late');
    expect(tinker.make('ListedJob')).toBeInstanceOf(Listed);
    expect(() => tinker.make('Lat')).toThrow('No class or token is known by the name "Lat".');
    expect(() => tinker.make('ListedJo')).toThrow('Did you mean "ListedJob"?');
  });

  const availability = (tinker: TinkerSession) => Object.fromEntries(tinker.helpers().map((helper) => [helper.name, helper.available]));
  const helperValue = (tinker: TinkerSession, name: string) => tinker.helpers().find((helper) => helper.name === name)!.value();
  type Binder = { instance(key: unknown, value: unknown): Binder; singleton(key: unknown, create: () => unknown): Binder };
  const ownApp = (root: string, bind: (container: Binder) => void = () => {}) => createApplication({ root, discover: false, modules: [] }, { env: {}, override: (container) => bind(container as unknown as Binder) });
  const NEEDS = (helper: string, pkg: string, short: string) => `${helper} needs ${pkg} in your app's package.json, installed (marmeon add ${short}, or install your dependencies).`;
  const UNREGISTERED = (helper: string, pkg: string) => `${helper} needs ${pkg}: it is installed, but its provider is not registered (marmeon discover).`;

  it('never makes a helper available, nor lets the sandbox open, with a job named like their packages\' classes', async () => {
    const providers = [providerOf(['Connections', 'Database', 'Queue', 'Mailer'].map(job))];
    const { tinker } = await session({ providers, sandbox: true });
    await expect(tinker.open()).rejects.toThrow('--sandbox needs @marmeon/database');
    expect(availability(tinker)).toMatchObject({ db: false, repos: false, jobs: false, mail: false });
    expect(() => helperValue(tinker, 'db')).toThrow('db needs @marmeon/database');
    expect(tinker.names()).toEqual(expect.arrayContaining(['Connections', 'Database', 'Queue', 'Mailer']));
  });

  it('lets no module class named like the database package\'s Connections open the sandbox, nor stand in for db and repos', async () => {
    const calls: string[] = [];
    const Connections = class {
      transaction(fn: () => unknown) {
        calls.push('transaction');
        return fn();
      }
    };
    const { tinker } = await session({ modules: [defineModule({ name: 'imposter', jobs: [Connections as never, job('Database')] })], bind: (container: { singleton(key: unknown, create: () => unknown): void }) => container.singleton(Connections, () => new Connections()), sandbox: true });
    await expect(tinker.open()).rejects.toThrow('--sandbox needs @marmeon/database');
    expect(calls).toEqual([]);
    expect(tinker.database()).toBeUndefined();
    expect(availability(tinker)).toMatchObject({ db: false, repos: false });
    expect(() => helperValue(tinker, 'repos')).toThrow('repos needs @marmeon/database');
  });

  it('lets no module class named Queue or Mailer stand in for jobs and mail', async () => {
    const Queue = job('Queue');
    const Mailer = job('Mailer');
    const Database = token<object>('Database');
    const { tinker } = await session({ modules: [defineModule({ name: 'imposter', jobs: [Queue, Mailer] })], bind: (container: { singleton(key: unknown, create: () => unknown): { singleton(key: unknown, create: () => unknown): { instance(key: unknown, value: unknown): unknown } } }) => container.singleton(Queue, () => new Queue()).singleton(Mailer, () => new Mailer()).instance(Database, {}) });
    expect(availability(tinker)).toMatchObject({ db: false, jobs: false, mail: false });
    expect(() => helperValue(tinker, 'jobs')).toThrow('jobs needs @marmeon/queue');
  });

  it('control: opens the sandbox on the app\'s own packages, which make every helper available', async () => {
    const root = tempDir('marmeon-tinker-own-');
    const { Connections, Database } = await installOwnPackage(root, 'database', ['Connections', 'Database']);
    const { Queue } = await installOwnPackage(root, 'queue', ['Queue']);
    const { Mailer } = await installOwnPackage(root, 'mail', ['Mailer']);
    const calls: string[] = [];
    const app = await ownApp(root, (container) => {
      container.instance(Connections, { transaction: (fn: () => Promise<unknown>) => (calls.push('transaction'), fn()), options: () => ({ driver: 'sqlite', database: 'x' }) }).instance(Database, {}).instance(Queue, {}).instance(Mailer, {});
    });
    const tinker = new TinkerSession(app, { sandbox: true });
    await tinker.open();
    expect(calls).toEqual(['transaction']);
    expect(availability(tinker)).toMatchObject({ db: true, repos: true, jobs: true, mail: true });
    await expect(tinker.close()).resolves.toBeUndefined();
  });

  it('refuses --sandbox, and offers no db or repos, for an own package that is listed and installed but whose provider binds nothing', async () => {
    const root = tempDir('marmeon-tinker-own-');
    await installOwnPackage(root, 'database', ['Connections', 'Database']);
    const tinker = new TinkerSession(await ownApp(root), { sandbox: true });
    await expect(tinker.open()).rejects.toThrow(UNREGISTERED('--sandbox', '@marmeon/database'));
    expect(built(root)).toBe(0);
    expect(tinker.database()).toBeUndefined();
    expect(built(root)).toBe(0);
    expect(availability(tinker)).toMatchObject({ db: false, repos: false });
    expect(() => helperValue(tinker, 'db')).toThrow(UNREGISTERED('db', '@marmeon/database'));
  });

  it('refuses --sandbox for a same-named Connections bound beside an own package that is not bound', async () => {
    const root = tempDir('marmeon-tinker-own-');
    await installOwnPackage(root, 'database', ['Connections']);
    const Imposter = job('Connections');
    const calls: string[] = [];
    const app = await ownApp(root, (container) => {
      container.instance(token<unknown>('Connections'), { transaction: () => calls.push('token') }).instance(Imposter, { transaction: () => calls.push('class') });
    });
    const tinker = new TinkerSession(app, { sandbox: true });
    await expect(tinker.open()).rejects.toThrow(UNREGISTERED('--sandbox', '@marmeon/database'));
    expect(calls).toEqual([]);
  });

  const UNLOADABLE = (helper: string, pkg: string, name: string) => `${helper} needs ${pkg}: it is installed, but it could not be loaded or lacks ${name} (reinstall it at your app's version).`;
  /** Code of an entry that records in `marker` that it ran, and exports a Queue token. */
  const marking = (marker: string) => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export const Queue = Object.freeze({ key: Symbol('Queue'), name: 'Queue' });\n`;

  it('leaves jobs unavailable, and open() unrejected, when a listed package throws as it loads', async () => {
    const root = tempDir('marmeon-tinker-own-');
    await installOwnPackage(root, 'queue', [], { code: "throw new Error('boom');\n" });
    const tinker = new TinkerSession(await ownApp(root));
    await expect(tinker.open()).resolves.toBeUndefined();
    expect(availability(tinker).jobs).toBe(false);
    expect(() => helperValue(tinker, 'jobs')).toThrow(UNLOADABLE('jobs', '@marmeon/queue', 'Queue'));
    expect(() => helperValue(tinker, 'jobs')).not.toThrow('boom');
  });

  it('says it could not be loaded, not that it is missing, for a listed package without the export', async () => {
    const root = tempDir('marmeon-tinker-own-');
    await installOwnPackage(root, 'mail', [], { code: 'export const Other = {};\n' });
    const tinker = new TinkerSession(await ownApp(root));
    await tinker.open();
    expect(() => helperValue(tinker, 'mail')).toThrow(UNLOADABLE('mail', '@marmeon/mail', 'Mailer'));
  });

  it('says it is not installed for a package the app lists but does not have', async () => {
    const root = tempDir('marmeon-tinker-own-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@marmeon/queue': '*' } }));
    const tinker = new TinkerSession(await ownApp(root));
    await tinker.open();
    expect(() => helperValue(tinker, 'jobs')).toThrow(NEEDS('jobs', '@marmeon/queue', 'queue'));
  });

  describe('never imports an entry that leads out of its package', () => {
    /** Installs `@marmeon/mail` listed, lets `lead` point its entry somewhere, and expects the marker never to appear and `mail` unavailable. */
    const refused = async (lead: (root: string, dir: string, code: string) => void) => {
      const root = tempDir('marmeon-tinker-own-');
      const marker = join(root, 'loaded');
      const dir = join(root, 'node_modules/@marmeon/mail');
      await installOwnPackage(root, 'mail', [], { code: '' });
      lead(root, dir, marking(marker).replace('Queue', 'Mailer'));
      const tinker = new TinkerSession(await ownApp(root));
      await tinker.open();
      expect(existsSync(marker)).toBe(false);
      expect(availability(tinker).mail).toBe(false);
      expect(() => helperValue(tinker, 'mail')).toThrow(UNLOADABLE('mail', '@marmeon/mail', 'Mailer'));
    };
    const exportsTo = (dir: string, target: string) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@marmeon/mail', type: 'module', exports: target }));

    it('by its exports (`./../../outside/evil.js`)', () =>
      refused((root, dir, code) => {
        mkdirSync(join(root, 'node_modules/outside'), { recursive: true });
        writeFileSync(join(root, 'node_modules/outside/evil.js'), code);
        exportsTo(dir, './../../outside/evil.js');
      }));

    it('by a symlink to a file outside it', () =>
      refused((root, dir, code) => {
        writeFileSync(join(root, 'outside-mailer.js'), code);
        rmSync(join(dir, 'index.js'));
        symlinkSync(join(root, 'outside-mailer.js'), join(dir, 'index.js'));
      }));

    it('by a symlink into a package nested in its own node_modules', () =>
      refused((_root, dir, code) => {
        mkdirSync(join(dir, 'node_modules/other'), { recursive: true });
        writeFileSync(join(dir, 'node_modules/other/index.js'), code);
        rmSync(join(dir, 'index.js'));
        symlinkSync(join(dir, 'node_modules/other/index.js'), join(dir, 'index.js'));
      }));

    it('by exports into a package nested in its own node_modules', () =>
      refused((_root, dir, code) => {
        mkdirSync(join(dir, 'node_modules/other'), { recursive: true });
        writeFileSync(join(dir, 'node_modules/other/index.js'), code);
        exportsTo(dir, './node_modules/other/index.js');
      }));
  });

  it('refuses --sandbox, calling no transaction, for a listed @marmeon/database that throws as it loads', async () => {
    const root = tempDir('marmeon-tinker-own-');
    await installOwnPackage(root, 'database', [], { code: "throw new Error('boom');\n" });
    const calls: string[] = [];
    const Imposter = job('Connections');
    const app = await ownApp(root, (container) => {
      container.instance(Imposter, { transaction: () => calls.push('transaction') });
    });
    const tinker = new TinkerSession(app, { sandbox: true });
    await expect(tinker.open()).rejects.toThrow(UNLOADABLE('--sandbox', '@marmeon/database', 'Connections'));
    expect(calls).toEqual([]);
  });

  it('refuses --sandbox for a hoisted copy that the app does not list, though its Connections is bound', async () => {
    const root = tempDir('marmeon-tinker-own-');
    await installOwnPackage(root, 'auth', ['Auth']);
    const { Connections } = await installOwnPackage(root, 'database', ['Connections', 'Database'], { listed: false });
    const app = await ownApp(root, (container) => {
      container.instance(Connections, { transaction: () => 'ran' });
    });
    expect(app.container.has(Connections as never)).toBe(true);
    const tinker = new TinkerSession(app, { sandbox: true });
    await expect(tinker.open()).rejects.toThrow(NEEDS('--sandbox', '@marmeon/database', 'database'));
    expect(built(root)).toBe(0);
  });

  it('refuses --sandbox for a copy that only another listed package depends on, though its Connections is bound', async () => {
    const root = tempDir('marmeon-tinker-own-');
    const auth = join(root, 'node_modules/@marmeon/auth');
    await installOwnPackage(root, 'auth', ['Auth']);
    const { Connections } = await installOwnPackage(root, 'database', ['Connections', 'Database'], { at: auth, listed: false });
    const app = await ownApp(root, (container) => {
      container.instance(Connections, { transaction: () => 'ran' });
    });
    expect(app.container.has(Connections as never)).toBe(true);
    const tinker = new TinkerSession(app, { sandbox: true });
    await expect(tinker.open()).rejects.toThrow(NEEDS('--sandbox', '@marmeon/database', 'database'));
    expect(built(root)).toBe(0);
  });

  describe('with a second copy of @marmeon/database', () => {
    const NAME = '@marmeon/database';
    const LEAD = `--sandbox refuses: ${NAME} is installed more than once, and writes through another copy would not be rolled back.`;
    const FIX = 'Install one copy: docs/package-development.md#one-copy-of-a-framework-package';
    const UNKNOWN = 'in a version that cannot be read';
    const line = (holder: string, copy: string, fix = "align the peers' versions, then pnpm dedupe") => `  ${holder} resolves its own copy of ${NAME} ${copy}, the app has 1.0.0: ${fix}`;
    const put = (dir: string, manifest: object | string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    };
    const list = (root: string, group: string, deps: Record<string, string>) => {
      const file = join(root, 'package.json');
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
      writeFileSync(file, JSON.stringify({ ...json, [group]: { ...json[group], ...deps } }));
    };
    /** An app whose @marmeon/database is the one tinker loads (version 1.0.0), and what `build` installs besides. */
    async function layout(build: (root: string) => void, under = '') {
      const base = realpathSync(tempDir('marmeon-tinker-copies-'));
      const root = under ? join(base, under) : base;
      mkdirSync(root, { recursive: true });
      const { Connections } = await installOwnPackage(root, 'database', ['Connections', 'Database']);
      put(join(root, 'node_modules/@marmeon/database'), { name: NAME, version: '1.0.0', type: 'module', exports: './index.js' });
      build(root);
      const calls: string[] = [];
      const app = await ownApp(root, (container) => {
        container.instance(Connections, { transaction: (fn: () => Promise<unknown>) => (calls.push('transaction'), fn()), options: () => ({ driver: 'sqlite', database: 'x' }) });
      });
      return { app, calls };
    }
    const message = async (app: Application): Promise<string> => {
      const error = await new TinkerSession(app, { sandbox: true }).open().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      return error instanceof Error ? error.message : 'opened';
    };
    const copyIn = (dir: string, version?: string) => put(join(dir, 'node_modules/@marmeon/database'), { name: NAME, ...(version ? { version } : {}) });
    const holder = (root: string, name: string, manifest: object, at = root) => put(join(at, 'node_modules', name), { name, version: '2.0.0', ...manifest });

    it.each([
      [
        'a holder that pins another exact version',
        (root: string) => {
          holder(root, 'acme', { dependencies: { [NAME]: '0.9.0' } });
          copyIn(join(root, 'node_modules/acme'), '0.9.0');
          list(root, 'dependencies', { acme: '2.0.0' });
        },
        [line('acme', '0.9.0', `use a version of acme that depends on the app's, or override ${NAME} to 1.0.0`)],
      ],
      [
        'a transitive holder',
        (root: string) => {
          holder(root, 'acme-x', { dependencies: { 'acme-y': '1.0.0' } });
          holder(root, 'acme-y', { peerDependencies: { [NAME]: '1.0.0' } }, join(root, 'node_modules/acme-x'));
          copyIn(join(root, 'node_modules/acme-x/node_modules/acme-y'), '1.0.0');
          list(root, 'dependencies', { 'acme-x': '2.0.0' });
        },
        [line('acme-y', '1.0.0')],
      ],
      [
        'a holder the app lists under optionalDependencies',
        (root: string) => {
          holder(root, 'acme', { peerDependencies: { [NAME]: '1.0.0' } });
          copyIn(join(root, 'node_modules/acme'), '1.0.0');
          list(root, 'optionalDependencies', { acme: '2.0.0' });
        },
        [line('acme', '1.0.0')],
      ],
      [
        'a holder the app lists under peerDependencies',
        (root: string) => {
          holder(root, 'acme', { peerDependencies: { [NAME]: '1.0.0' } });
          copyIn(join(root, 'node_modules/acme'), '1.0.0');
          list(root, 'peerDependencies', { acme: '2.0.0' });
        },
        [line('acme', '1.0.0')],
      ],
      [
        'an alias key the app lists',
        (root: string) => {
          put(join(root, 'node_modules/mdb'), { name: NAME, version: '1.0.0' });
          list(root, 'dependencies', { mdb: `npm:${NAME}@1.0.0` });
        },
        [`  the app lists ${NAME} a second time as "mdb" — list it once`],
      ],
      [
        'a holder and a copy without a version',
        (root: string) => {
          put(join(root, 'node_modules/acme'), { name: 'acme', peerDependencies: { [NAME]: '1.0.0' } });
          copyIn(join(root, 'node_modules/acme'));
          list(root, 'dependencies', { acme: '2.0.0' });
        },
        [line('acme', UNKNOWN)],
      ],
      [
        'a holder the app lists under devDependencies',
        (root: string) => {
          holder(root, 'acme', { peerDependencies: { [NAME]: '1.0.0' } });
          copyIn(join(root, 'node_modules/acme'), '1.0.0');
          list(root, 'devDependencies', { acme: '2.0.0' });
        },
        [line('acme', '1.0.0')],
      ],
      [
        'a holder that declares it in dependencies and in peerDependencies',
        (root: string) => {
          holder(root, 'acme', { dependencies: { [NAME]: '1.0.0' }, peerDependencies: { [NAME]: '1.0.0' } });
          copyIn(join(root, 'node_modules/acme'), '1.0.0');
          list(root, 'dependencies', { acme: '2.0.0' });
        },
        [line('acme', '1.0.0', `use a version of acme that depends on the app's, or override ${NAME} to 1.0.0`)],
      ],
      [
        'a workspace package that lists it only in devDependencies',
        (root: string) => {
          put(join(root, 'packages/ui'), { name: 'ui', version: '1.0.0', devDependencies: { [NAME]: '1.0.1' } });
          copyIn(join(root, 'packages/ui'), '1.0.1');
          mkdirSync(join(root, 'node_modules'), { recursive: true });
          symlinkSync(join(root, 'packages/ui'), join(root, 'node_modules/ui'), 'dir');
          list(root, 'dependencies', { ui: 'workspace:*' });
        },
        [line('ui', '1.0.1')],
      ],
      [
        'a copy declared only in optionalDependencies',
        (root: string) => {
          holder(root, 'acme', { optionalDependencies: { [NAME]: '1.0.0' } });
          copyIn(join(root, 'node_modules/acme'), '1.0.0');
          list(root, 'dependencies', { acme: '2.0.0' });
        },
        [line('acme', '1.0.0')],
      ],
    ])('refuses --sandbox for %s, naming the copy and calling no transaction', async (_label, build, lines) => {
      const { app, calls } = await layout(build);
      expect(await message(app)).toBe([LEAD, ...lines, FIX].join('\n'));
      expect(calls).toEqual([]);
    });

    it('refuses --sandbox when discovery lists @marmeon/database from more than one directory', async () => {
      const { app, calls } = await layout(() => {});
      Object.defineProperty(app, 'packages', { value: [NAME, NAME] });
      expect(await message(app)).toBe([LEAD, `  discovery found ${NAME} in more than one directory`, FIX].join('\n'));
      expect(calls).toEqual([]);
    });

    it('refuses --sandbox for a workspace package that lists it only in devDependencies, in an app checked out under a node_modules folder', async () => {
      const { app, calls } = await layout((root) => {
        put(join(root, 'packages/ui'), { name: 'ui', version: '1.0.0', devDependencies: { [NAME]: '1.0.1' } });
        copyIn(join(root, 'packages/ui'), '1.0.1');
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        symlinkSync(join(root, 'packages/ui'), join(root, 'node_modules/ui'), 'dir');
        list(root, 'dependencies', { ui: 'workspace:*' });
      }, 'node_modules/checkout/app');
      expect(await message(app)).toBe([LEAD, line('ui', '1.0.1'), FIX].join('\n'));
      expect(calls).toEqual([]);
    });

    it('refuses --sandbox, saying the install could not be checked, for a package.json on the walk that cannot be read', async () => {
      const { app, calls } = await layout((root) => {
        put(join(root, 'node_modules/acme'), '{ not json');
        list(root, 'dependencies', { acme: '2.0.0' });
      });
      expect(await message(app)).toBe(`--sandbox refuses: the install could not be checked for a second copy of ${NAME} (node_modules/acme has a package.json that cannot be read).`);
      expect(calls).toEqual([]);
    });

    it('opens --sandbox when a holder has a second copy of another package but one @marmeon/database', async () => {
      const { app, calls } = await layout((root) => {
        put(join(root, 'node_modules/@marmeon/storage'), { name: '@marmeon/storage', version: '1.0.0' });
        holder(root, 'acme', { peerDependencies: { [NAME]: '1.0.0', '@marmeon/storage': '1.0.0' } });
        put(join(root, 'node_modules/acme/node_modules/@marmeon/storage'), { name: '@marmeon/storage', version: '1.0.0' });
        list(root, 'dependencies', { acme: '2.0.0' });
      });
      const tinker = new TinkerSession(app, { sandbox: true });
      await tinker.open();
      expect(calls).toEqual(['transaction']);
      await tinker.close();
    });

    it('opens --sandbox for a pnpm store of symlinks that leads to one copy', async () => {
      const { app, calls } = await layout((root) => {
        const store = join(root, 'node_modules/.pnpm/acme@2.0.0/node_modules');
        put(join(store, 'acme'), { name: 'acme', version: '2.0.0', peerDependencies: { [NAME]: '1.0.0' } });
        mkdirSync(join(store, '@marmeon'), { recursive: true });
        symlinkSync(join(root, 'node_modules/@marmeon/database'), join(store, '@marmeon/database'), 'dir');
        symlinkSync(join(store, 'acme'), join(root, 'node_modules/acme'), 'dir');
        list(root, 'dependencies', { acme: '2.0.0' });
      });
      const tinker = new TinkerSession(app, { sandbox: true });
      await tinker.open();
      expect(calls).toEqual(['transaction']);
      await tinker.close();
    });

    it('cannot check a tree that is deeper than the step limit, nor an app without a copy', async () => {
      const { app } = await layout((root) => {
        holder(root, 'acme', { peerDependencies: { [NAME]: '1.0.0' } });
        list(root, 'dependencies', { acme: '2.0.0' });
      });
      expect(() => secondCopies(app.root, NAME, 1)).toThrow(new UnreadableTree('the dependencies of the app could not be followed to an end'));
      const bare = realpathSync(tempDir('marmeon-tinker-copies-'));
      put(bare, { name: 'bare' });
      expect(() => secondCopies(bare, NAME)).toThrow(new UnreadableTree(`the app's copy of ${NAME} was not found`));
    });

    it('opens --sandbox when every package resolves the one copy', async () => {
      const { app, calls } = await layout((root) => {
        holder(root, 'acme', { peerDependencies: { [NAME]: '1.0.0' } });
        list(root, 'dependencies', { acme: '2.0.0' });
      });
      const tinker = new TinkerSession(app, { sandbox: true });
      await tinker.open();
      expect(calls).toEqual(['transaction']);
      await tinker.close();
    });

    it('opens without --sandbox, whatever the tree holds', async () => {
      const { app, calls } = await layout((root) => {
        holder(root, 'acme', { dependencies: { [NAME]: '0.9.0' } });
        copyIn(join(root, 'node_modules/acme'), '0.9.0');
        list(root, 'dependencies', { acme: '2.0.0' });
      });
      await new TinkerSession(app).open();
      expect(calls).toEqual([]);
    });
  });

  it('never imports a package that only a parent directory reaches and the app does not list', async () => {
    const parent = tempDir('marmeon-tinker-parent-');
    const marker = join(parent, 'loaded');
    await installOwnPackage(parent, 'queue', [], { code: marking(marker), listed: false });
    const root = join(parent, 'app');
    mkdirSync(root);
    const tinker = new TinkerSession(await ownApp(root));
    await tinker.open();
    expect(existsSync(marker)).toBe(false);
    expect(availability(tinker).jobs).toBe(false);
  });

  describe('the banner of a database the app does not list', () => {
    const connectionsOf = (root: string) => installOwnPackage(root, 'database', ['Connections', 'Database'], { listed: false });
    const bind = (Connections: Key) => (container: Binder) => {
      container.instance(Connections, { options: () => ({ driver: 'sqlite', database: 'x' }), transaction: () => 'ran' });
    };

    it('warns, naming nothing of the database, for a registered copy the app does not list', async () => {
      const root = tempDir('marmeon-tinker-own-');
      await installOwnPackage(root, 'auth', ['Auth']);
      const { Connections } = await connectionsOf(root);
      const tinker = new TinkerSession(await ownApp(root, bind(Connections)));
      await tinker.open();
      expect(tinker.database()).toBeUndefined();
      expect(tinker.databaseWarning()).toBe("db not shown (@marmeon/database is not in your package.json, or not installed; make('Connections') may still reach one)");
    });

    it('is unchanged for a listed, bound copy, and silent where nothing is named Connections', async () => {
      const listed = tempDir('marmeon-tinker-own-');
      const { Connections } = await installOwnPackage(listed, 'database', ['Connections', 'Database']);
      const own = new TinkerSession(await ownApp(listed, bind(Connections)));
      await own.open();
      expect(own.database()).toBe('sqlite (x)');
      expect(own.databaseWarning()).toBeUndefined();
      const bare = new TinkerSession(await ownApp(tempDir('marmeon-tinker-own-')));
      await bare.open();
      expect(bare.databaseWarning()).toBeUndefined();
    });
  });

  it('says in .ls why a helper is not available: not installed, not loadable or not registered', async () => {
    const root = tempDir('marmeon-tinker-own-');
    await installOwnPackage(root, 'database', ['Connections', 'Database']);
    await installOwnPackage(root, 'mail', [], { code: "throw new Error('boom');\n" });
    const tinker = new TinkerSession(await ownApp(root));
    await tinker.open();
    expect(Object.fromEntries(tinker.helpers().map((helper) => [helper.name, helper.problem]))).toMatchObject({ db: 'unregistered', repos: 'unregistered', mail: 'unloadable', jobs: 'missing' });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    const listed = Promise.withResolvers<void>();
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes('Names (')) listed.resolve();
    });
    const done = interactive(tinker, { history: undefined, input, output });
    input.write('.ls\n');
    await listed.promise;
    input.end('.exit\n');
    await done;
    expect(text).toMatch(/Kysely on the default connection\s+\S*\(not registered\)/);
    expect(text).toMatch(/the Mailer\s+\S*\(not loadable\)/);
    expect(text).toMatch(/the Queue\s+\S*\(not installed\)/);
  });

  it('refuses the helpers and the banner until open() ran', async () => {
    const { app } = await session();
    const tinker = new TinkerSession(app);
    expect(() => tinker.helpers()).toThrow('TinkerSession: call open() first.');
    expect(() => tinker.database()).toThrow('TinkerSession: call open() first.');
    await tinker.open();
    expect(() => tinker.helpers()).not.toThrow();
  });

  it('gives way to a container binding, a module class and a listener of the same name', async () => {
    const Mailer = token<{ send(): string }>('Mailer');
    const Event = class Signal {};
    class Twin {}
    const Heard = job('Heard');
    class Listener {
      handle() {}
    }
    Object.defineProperty(Listener, 'name', { value: 'Heard' });
    const modules = [defineModule({ name: 'shop', jobs: [Twin as never], listeners: [listen(Event, Listener as never)] })];
    const { tinker } = await session({ providers: [providerOf([job('Mailer'), job('Twin'), Heard])], modules, bind: (container: { instance(key: unknown, value: unknown): void }) => container.instance(Mailer, { send: () => 'bound' }) });
    expect((tinker.make('Mailer') as { send(): string }).send()).toBe('bound');
    expect(tinker.make('Twin')).toBeInstanceOf(Twin);
    expect(tinker.make('Heard')).toBeInstanceOf(Listener);
  });

  it('gives way to a repository, for make() and the bare name, also one not named …Repository on the first input', async () => {
    const files = { 'modules/shop/OrderRepository.ts': repository('OrderRepository', 'orders'), 'modules/shop/ArchiveRepository.ts': repository('ArchiveStore', 'archive') };
    const { tinker } = await session({ providers: [providerOf([job('OrderRepository'), job('ArchiveStore')])], files });
    const context: Record<string, unknown> = {};
    tinker.attach(context);
    expect(Object.getOwnPropertyDescriptor(context, 'ArchiveStore')?.get).toBeTypeOf('function');
    await tinker.evaluate('ArchiveStore', async () => undefined);
    const Archive = context.ArchiveStore as { table?: string };
    expect(Archive.table).toBe('archive');
    await tinker.loadRepositories();
    expect((context.OrderRepository as { table?: string }).table).toBe('orders');
    expect((tinker.make('OrderRepository') as { constructor: { table: string } }).constructor.table).toBe('orders');
    expect(tinker.names().filter((name) => name === 'ArchiveStore')).toHaveLength(1);
  });

  it('takes a class of the app\'s own provider before a discovered one, and the first of a name', async () => {
    const Own = job('Twin');
    const Discovered = job('Twin');
    const OwnProvider = providerOf([Own]);
    const { app } = await session({ providers: [OwnProvider] });
    Object.defineProperty(app, 'providers', { value: [providerOf([Discovered]), OwnProvider] });
    const tinker = new TinkerSession(app);
    await tinker.open();
    expect(tinker.make('Twin')).toBeInstanceOf(Own);
    expect(tinker.names().filter((name) => name === 'Twin')).toHaveLength(1);
  });

  it('lets an assignment win on the context, and detach takes the name away', async () => {
    const { tinker } = await session({ providers: [providerOf([job('Twin')])] });
    const context: Record<string, unknown> = {};
    tinker.attach(context);
    expect(context.Twin).toBeTypeOf('function');
    context.Twin = 'mine';
    expect(context.Twin).toBe('mine');
    tinker.detach();
    expect('Twin' in context).toBe(false);
  });

  it('refuses an input that writes a job name out while the repositories do not load, and leaves other inputs alone', async () => {
    // One file that throws registers no repository at all, so the job could stand in for a healthy repository of its name.
    const files = {
      'modules/shop/BrokenRepository.ts': "throw new Error('boom');\n",
      'modules/shop/LedgerRepository.ts': repository('Ledger', 'ledger'),
    };
    const { tinker } = await session({ providers: [providerOf([job('Ledger'), job('Mail')])], files });
    await expect(tinker.evaluate("make('Ledger')", async () => 'the job ran')).rejects.toThrow('boom');
    await expect(tinker.evaluate('Mail', async () => 'the job ran')).rejects.toThrow('boom');
    expect(await tinker.evaluate("make('Mailer')", async () => 'other')).toBe('other');
    await expect(tinker.evaluate('repos', async () => 'never')).rejects.toThrow('boom');
  });

  it('preloads only for a whole name no other name has, and lets a repository win on the first input', async () => {
    const files = { 'modules/shop/LedgerRepository.ts': repository('Ledger', 'ledger') };
    const { tinker } = await session({ providers: [providerOf([job('Ledger')])], files });
    const context: Record<string, unknown> = {};
    tinker.attach(context);
    await tinker.evaluate('LedgerEntry', async () => undefined);
    expect((context.Ledger as { table?: string }).table).toBeUndefined();
    await tinker.evaluate('Ledger', async () => undefined);
    expect((context.Ledger as { table?: string }).table).toBe('ledger');
  });

  it('detaches without throwing when an input made the name its own, non-configurable', async () => {
    const { tinker } = await session({ providers: [providerOf([job('Mail')])] });
    const context: Record<string, unknown> = {};
    tinker.attach(context);
    Object.defineProperty(context, 'Mail', { value: () => 'script', configurable: false });
    expect(() => tinker.detach()).not.toThrow();
  });

  it('knows no name for an entry that is no class, and leaves a global of a job\'s name alone', async () => {
    const { tinker } = await session({ providers: [providerOf([{ name: 'Plain' }, job('URL')])] });
    expect(tinker.names()).not.toContain('Plain');
    const context: Record<string, unknown> = { URL };
    tinker.attach(context);
    expect(context.URL).toBe(URL);
  });

  it('never reads a string `jobs` or `providerJobs`, not even a getter that throws', async () => {
    const otherSymbol: unique symbol = Symbol.for('providerJobs');
    const Plain = class {
      static jobs = [job('ByJobs')];
      static providerJobs = [job('ByKey')];
      static ['marmeon.provider.jobs'] = [job('ByDescription')];
      static [otherSymbol] = [job('ByOtherSymbol')];
      boot() {}
    } as unknown as ServiceProviderClass;
    const Getters = class {
      static get jobs(): never { throw new Error('read'); }
      static get providerJobs(): never { throw new Error('read'); }
      static get ['marmeon.provider.jobs'](): never { throw new Error('read'); }
      boot() {}
    } as unknown as ServiceProviderClass;
    const { tinker } = await session({ providers: [Plain, Getters] });
    expect(tinker.names()).not.toEqual(expect.arrayContaining(['ByJobs']));
    for (const name of ['ByKey', 'ByDescription', 'ByOtherSymbol']) expect(tinker.names()).not.toContain(name);
  });

  it('does not break on a class whose name is a symbol or a number, nor on a bad value', async () => {
    const Odd = job('Odd');
    Object.defineProperty(Odd, 'name', { value: Symbol('odd') });
    const Numbered = job('Numbered');
    Object.defineProperty(Numbered, 'name', { value: 7 });
    const Fine = job('Fine');
    const providers = [providerOf([Odd, Numbered, null, 'Text', Fine]), providerOf('Text'), providerOf(undefined), providerOf({ length: 1, 0: job('Object') })];
    const modules = [defineModule({ name: 'odd', jobs: [Odd as never, Numbered as never] })];
    const { tinker } = await session({ providers, modules });
    expect(tinker.names()).toEqual(expect.arrayContaining(['Fine']));
    expect(tinker.names()).not.toEqual(expect.arrayContaining(['Text', 'Object', 'Numbered']));
    expect(tinker.names().every((name) => typeof name === 'string')).toBe(true);
  });
});

/** How many times a fake package's `Connections` was built (see {@link installOwnPackage}), by the key of its root. */
const built = (root: string): number => ((globalThis as Record<string, unknown>)[`tinker-built:${root}`] as number | undefined) ?? 0;

/**
 * Installs `@marmeon/<name>` under `<at>/node_modules` as a package of its own: a class for `Connections`, a token-shaped object (what
 * `token()` makes) for every other name in `exports`. `listed` (default) lists it in the package.json of `root`. Returns what an import of its
 * entry gives — the same module instance tinker loads.
 */
async function installOwnPackage(root: string, name: string, exports: readonly string[], options: { listed?: boolean; at?: string; code?: string } = {}): Promise<Record<'Connections' | 'Database' | 'Queue' | 'Mailer' | 'Auth', Key>> {
  const dir = join(options.at ?? root, 'node_modules/@marmeon', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@marmeon/${name}`, type: 'module', exports: './index.js' }));
  const counter = JSON.stringify(`tinker-built:${root}`);
  const code =
    options.code ??
    exports
      .map((entry) =>
        entry === 'Connections'
          ? `export class Connections { constructor() { globalThis[${counter}] = (globalThis[${counter}] ?? 0) + 1; } }\n`
          : `export const ${entry} = Object.freeze({ key: Symbol(${JSON.stringify(entry)}), name: ${JSON.stringify(entry)} });\n`,
      )
      .join('');
  writeFileSync(join(dir, 'index.js'), code);
  if (options.listed !== false) {
    const file = join(root, 'package.json');
    const json = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> }) : {};
    writeFileSync(file, JSON.stringify({ ...json, dependencies: { ...json.dependencies, [`@marmeon/${name}`]: '*' } }));
  }
  return options.code === undefined ? ((await import(pathToFileURL(join(dir, 'index.js')).href)) as Record<'Connections' | 'Database' | 'Queue' | 'Mailer' | 'Auth', Key>) : ({} as never);
}

describe('the database line of the tinker banner', () => {
  const banner = async (options: unknown) => {
    const root = tempDir('marmeon-tinker-banner-');
    const { Connections } = await installOwnPackage(root, 'database', ['Connections', 'Database']);
    const app = await createApplication({ root, discover: false, modules: [] }, { env: {}, override: (container) => container.instance(Connections, { options: () => options }) });
    const tinker = new TinkerSession(app);
    await tinker.open();
    return tinker.database();
  };

  it('is not shown for a token named Connections that is not the database package\'s class', async () => {
    const app = await createApplication({ root: tempDir('marmeon-tinker-banner-'), discover: false, modules: [] }, { env: {}, override: (container) => container.instance(token<unknown>('Connections'), { options: () => ({ driver: 'sqlite', database: 'x' }) }) });
    const tinker = new TinkerSession(app);
    await tinker.open();
    expect(tinker.database()).toBeUndefined();
  });

  it.each([
    [{ driver: 'sqlite', database: 'storage/app.sqlite' }, 'sqlite (storage/app.sqlite)'],
    [{ driver: 'pgsql', url: 'postgres://app:hunter2x@db:5433/shop' }, 'pgsql (db:5433/shop)'],
    [{ driver: 'mysql', url: 'mysql://app:hunter2x@db:3307/shop' }, 'mysql (db:3307/shop)'],
  ])('names the driver and where, never the password: %j', async (options, expected) => {
    expect(await banner(options)).toBe(expected);
  });

  it.each([
    ['pgsql', 'postgres:app:hunter2x@db/shop'],
    ['pgsql', 'mysql://app:hunter2x@db/shop'],
    ['mysql', 'mysql:app:hunter2x@db/shop'],
    ['mysql', 'app:hunter2x@tcp(db)/shop'],
    ['mysql', 'postgres://app:hunter2x@db/shop'],
  ])('shows %s (invalid URL) for %s, with nothing of it', async (driver, url) => {
    expect(await banner({ driver, url })).toBe(`${driver} (invalid URL)`);
  });

  it('shows the libpq socket form, which has no host', async () => {
    expect(await banner({ driver: 'pgsql', url: 'postgresql:///app?host=/var/run/postgresql' })).toBe('pgsql (/app)');
  });

  it.each(['postgres:///app:hunter2x@h/db', 'postgres:///app@h/db?host=/tmp', 'postgres:///app?host=socket'])('refuses %s as no URL of a server', async (url) => {
    expect(await banner({ driver: 'pgsql', url })).toBe('pgsql (invalid URL)');
  });

  it.each(['postgres:///app%3Ahunter2x%40h/db?host=/tmp', 'postgres:///app%3ahunter2x%40h/db?host=/tmp', 'postgres://us/er:hunter2x@db/shop', 'postgres://db/app:hunter2x', 'postgres://db/%E0%A4%A'])(
    'refuses %s: the decoded path holds `@` or `:`, or does not decode',
    async (url) => {
      expect(await banner({ driver: 'pgsql', url })).toBe('pgsql (invalid URL)');
    },
  );

  it('refuses a password with `@` in it, whose rest would land in the path the banner prints', async () => {
    expect(await banner({ driver: 'pgsql', url: 'postgres://app:p@ss/w0rd@db/shop' })).toBe('pgsql (invalid URL)');
  });

  it('refuses a driver it does not know', async () => {
    await expect(banner({ driver: 'oracle', url: 'oracle://h/db' })).rejects.toThrow(/^\[marmeon:D29\] The database driver "oracle" is not one Marmeon knows\.$/);
  });
});
