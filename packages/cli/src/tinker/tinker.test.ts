import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApplication, defineModule, listen, providerJobs, token, type Application, type ServiceProviderClass } from '@marmeon/core';
import { defineRoutes, Router } from '@marmeon/router';
import { TinkerCommand } from '../commands/tinker.ts';
import { completer, interactive } from './repl.ts';
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
    const context: Record<string, unknown> = { url: 'mine', URL };
    tinker.attach(context);
    expect(context.url).toBeTypeOf('function'); // the helper wins over what the context had …
    expect((context.url as (name: string, params?: object) => string)('orders.show', { order: 7 })).toBe('/orders/7');
    expect(context.app).toBe(app);
    expect(context.Mailer).toBe(Mailer); // names are their class or token
    expect(context.URL).toBe(URL); // … a name the context had stays
    expect(Object.getOwnPropertyDescriptor(context, 'db')?.get).toBeTypeOf('function'); // built on first use
    expect(() => context.db).toThrow('db needs @marmeon/database (marmeon add database; if it is installed already: marmeon discover).');
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
    ['repos', 'repos needs @marmeon/database (marmeon add database; if it is installed already: marmeon discover).'],
    ['t', 't needs @marmeon/i18n (marmeon add i18n; if it is installed already: marmeon discover).'],
  ])('names the install of the package the helper %s lacks', (helper, message) => {
    const context: Record<string, unknown> = {};
    new TinkerSession(app).attach(context);
    expect(() => context[helper]).toThrow(message);
  });

  it('refuses --sandbox without @marmeon/database, and names the install', async () => {
    await expect(new TinkerSession(app, { sandbox: true }).open()).rejects.toThrow('--sandbox needs @marmeon/database (marmeon add database; if it is installed already: marmeon discover).');
  });

  describe('the history file', () => {
    const sit = async (history: string | undefined) => {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const done = interactive(new TinkerSession(app), { history, input, output });
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
    return { app, tinker: new TinkerSession(app, { sandbox: options.sandbox }) };
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

  it('never makes a helper available, nor lets the sandbox open, with a job named like their packages\' classes', async () => {
    const providers = [providerOf(['Connections', 'Database', 'Queue', 'Mailer'].map(job))];
    const { tinker } = await session({ providers, sandbox: true });
    const available = Object.fromEntries(tinker.helpers().map((helper) => [helper.name, helper.available]));
    expect(available).toMatchObject({ db: false, repos: false, jobs: false, mail: false });
    expect(() => tinker.helpers().find((helper) => helper.name === 'db')!.value()).toThrow('db needs @marmeon/database');
    await expect(tinker.open()).rejects.toThrow('--sandbox needs @marmeon/database');
    expect(tinker.names()).toEqual(expect.arrayContaining(['Connections', 'Database', 'Queue', 'Mailer']));
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

describe('the database line of the tinker banner', () => {
  const Connections = token<unknown>('Connections');
  const banner = async (options: unknown) => {
    const app = await createApplication({ root: tempDir('marmeon-tinker-banner-'), discover: false, modules: [] }, { env: {}, override: (container) => container.instance(Connections, { options: () => options }) });
    return new TinkerSession(app).database();
  };

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
