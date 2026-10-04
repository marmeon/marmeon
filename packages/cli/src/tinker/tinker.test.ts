import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication, defineModule, token, type Application } from '@bespokecore/core';
import { defineRoutes, Router } from '@bespokecore/router';
import { completer } from './repl.ts';
import { TinkerSession } from './session.ts';
import { toJavaScript } from './typescript.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bin = join(repo, 'packages/cli/bin/bespoke.js');
const webApp = join(repo, 'apps/web-app');
const PGSQL_URL = process.env.BESPOKE_TEST_PGSQL_URL;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The parent's environment for a `bespoke` child: the launcher must re-exec, and the database is the one a test names. */
function environment(env: Record<string, string>): NodeJS.ProcessEnv {
  const { BESPOKE_CHILD: _child, DB_CONNECTION: _connection, DB_URL: _url, ...parent } = process.env;
  return { ...parent, NO_COLOR: '1', ...env };
}

function bespoke(args: readonly string[], env: Record<string, string>): Run {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: webApp, encoding: 'utf8', env: environment(env) });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `bespoke tinker` with piped input (W6.4: `stdin.end(…)`, or the REPL never sees the end of its input). */
function session(args: readonly string[], env: Record<string, string>, input: string): Promise<Run> {
  const child = spawn(process.execPath, [bin, 'tinker', ...args], { cwd: webApp, env: environment(env) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => (stdout += data));
  child.stderr.on('data', (data: Buffer) => (stderr += data));
  child.stdin.end(input);
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}

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
    root = mkdtempSync(join(tmpdir(), 'bespoke-tinker-'));
    // Repositories are found by file name and told apart by shape — without importing @bespokecore/database.
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
      env: {},
      modules: [defineModule({ name: 'shop', jobs: [ShipOrderJob] })],
      override: (container) => container.instance(Router, router).instance(Mailer, { send: () => 'sent' }),
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

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
    expect(() => context.db).toThrow('db needs @bespokecore/database (pnpm add @bespokecore/database; bespoke discover).');
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

  it('refuses --sandbox without @bespokecore/database', async () => {
    await expect(new TinkerSession(app, { sandbox: true }).open()).rejects.toThrow('--sandbox needs @bespokecore/database');
  });
});

describe('bespoke tinker (in the web app, SQLite)', { timeout: 60_000 }, () => {
  let dir: string;
  let env: Record<string, string>;
  const count = (extra: Record<string, string> = {}) => Number(bespoke(['tinker', '--execute', 'await repos.users.count()'], { ...env, ...extra }).stdout.trim());

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bespoke-tinker-app-'));
    env = { DB_DATABASE: join(dir, 'app.sqlite') };
    const fresh = bespoke(['migrate:fresh', '--seed', '--no-types'], env);
    expect(fresh.code, fresh.stderr).toBe(0);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('prints the value of --execute — the number of users', () => {
    const { code, stdout, stderr } = bespoke(['tinker', '--execute', 'await repos.users.count()'], env);
    expect(code, stderr).toBe(0);
    const query = bespoke(['tinker', '-e', "Number((await db.selectFrom('users').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)"], env);
    expect(stdout).toBe(`${query.stdout.trim()}\n`);
    expect(Number(stdout)).toBeGreaterThan(0);
  });

  it('takes TypeScript and prints strings as they are (for scripts)', () => {
    const typed = bespoke(['tinker', '-e', 'interface Greeting { name: string }\nconst hello = (g: Greeting): string => `hello ${g.name}`;\nhello({ name: "Ada" } satisfies Greeting)'], env);
    expect(typed.stdout).toBe('hello Ada\n');
    expect(bespoke(['tinker', '-e', "url('user-profile.show', { user: 7 }, { tab: 'links' })"], env).stdout).toBe('/users/7?tab=links\n');
  });

  it('evaluates in the process’s own realm — a Date typed in is the framework’s Date', () => {
    // In a context of its own, `new Date()` is another realm's Date: the SQLite driver could not bind it.
    const { stdout, stderr } = bespoke(['tinker', '--sandbox', '-e', 'await repos.users.update(1, { email_verified_at: new Date(0) }); (await repos.users.find(1))!.email_verified_at'], env);
    expect(stdout, stderr).toBe('1970-01-01T00:00:00.000Z\n');
  });

  it('exits with 1 on an error — its stack without the evaluation, a TypeScript error by name', () => {
    const failed = bespoke(['tinker', '-e', 'await repos.users.findOrFail(987654)'], env);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/^✗ RecordNotFoundError: Not Found\n {4}at UserRepository\.findOrFail \(.*repository\.ts:\d+:\d+\)\n {4}at async REPL:1:\d+\n$/);
    const typescript = bespoke(['tinker', '-e', 'enum Role { Admin }'], env);
    expect(typescript.code).toBe(1);
    expect(typescript.stderr).toBe('✗ SyntaxError: TypeScript enum is not supported in strip-only mode\n');
  });

  it('keeps the sandbox transaction across inputs and rolls it back at the end — the database queue with it', async () => {
    const before = count();
    const { code, stdout } = await session(['--sandbox', '--no-history'], env, [
      `await repos.users.insert({ name: 'Tinker', email: 'tinker@example.com', password: 'x', locale: 'en' }); 'inserted'`,
      // The second input sees the first one's row: the same transaction.
      "`users:${await repos.users.count()}`",
      'await jobs.dispatch(SendWelcomeMailJob, { userId: 1 }); `jobs:${(await db.selectFrom("jobs").selectAll().execute()).length}`',
      '.exit',
      '',
    ].join('\n'));
    expect(code).toBe(0);
    expect(stdout).toContain('Sandbox: every change to the default connection is rolled back when the session ends');
    expect(stdout).toContain(`'users:${before + 1}'`);
    expect(stdout).toContain("'jobs:1'");
    expect(stdout).toContain('ℹ Sandbox: rolled back.');
    expect(count()).toBe(before);
    expect(bespoke(['tinker', '-e', '(await db.selectFrom("jobs").selectAll().execute()).length'], env).stdout).toBe('0\n');
  });

  it('rolls the sandbox back on SIGINT', async () => {
    const before = count();
    const child = spawn(process.execPath, [bin, 'tinker', '--sandbox', '--no-history'], { cwd: webApp, env: environment(env) });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => (stdout += data));
    const inserted = new Promise<void>((resolve) => child.stdout.on('data', () => stdout.includes("'inserted'") && resolve()));
    child.stdin.write(`await repos.users.insert({ name: 'Signal', email: 'signal@example.com', password: 'x', locale: 'en' }); 'inserted'\n`);
    await inserted;
    child.kill('SIGINT');
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(130);
    expect(stdout).toContain('ℹ Sandbox: rolled back.');
    expect(count()).toBe(before);
  });

  it('says why the cache cannot write on the app’s SQLite file inside the sandbox (E108) — instead of waiting', () => {
    const { code, stderr } = bespoke(['tinker', '--sandbox', '-e', "await make('Cache').put('greeting', 'hello', 60)"], { ...env, CACHE_DRIVER: 'database', CACHE_CONNECTION: 'default' });
    expect(code).toBe(1);
    expect(stderr).toContain('✗ InfrastructureTransactionError: The cache (CACHE_DRIVER=database');
    expect(stderr).toContain('! In --sandbox the whole session runs in one transaction on the default connection');
    // Without the sandbox, the same write works.
    expect(bespoke(['tinker', '-e', "await make('Cache').put('greeting', 'hello', 60); await make('Cache').get('greeting')"], { ...env, CACHE_DRIVER: 'database', CACHE_CONNECTION: 'default' }).stdout).toBe('hello\n');
  });

  it('logs without a request context', () => {
    const { stdout } = bespoke(['tinker', '-e', "make('Logger').info('from tinker', { step: 4 }); 'logged'"], { ...env, LOG_LEVEL: 'info', LOG_FORMAT: 'json' });
    const line = stdout.split('\n').find((text) => text.includes('from tinker'));
    expect(JSON.parse(line!)).toEqual({ level: 30, time: expect.any(Number), step: 4, msg: 'from tinker' });
  });

  it('shows the environment and the database in the banner — in production as a warning, never a secret', async () => {
    // Outside NODE_ENV=test the app reads .env, which a fresh checkout (CI) does not have: the test brings its configuration.
    const config = { APP_NAME: 'BespokeCore', APP_URL: 'http://localhost', APP_KEY: `base64:${Buffer.alloc(32, 7).toString('base64')}`, SYSTEM_DB_DATABASE: ':memory:', LOG_LEVEL: 'silent' };
    const production = { ...env, ...config, NODE_ENV: 'production' };
    const development = await session(['--no-history'], { ...env, ...config, NODE_ENV: 'development', DEVTOOLS_ENABLED: 'false' }, '.exit\n');
    expect(development.stdout).toContain(`BespokeCore tinker · @bespokecore/web-app · NODE_ENV=development · db sqlite (${env.DB_DATABASE}) · .ls lists helpers`);
    expect(development.stdout).not.toContain('PRODUCTION');
    const interactive = await session(['--no-history'], production, '.exit\n');
    expect(interactive.stdout).toContain(`PRODUCTION — NODE_ENV=production, db sqlite (${env.DB_DATABASE}): every change is real.`);
    expect(interactive.stdout).not.toContain(production.APP_KEY);
    // --execute: the value alone on stdout, the warning on stderr.
    const script = bespoke(['tinker', '--sandbox', '-e', '1 + 1'], production);
    expect(script.stdout).toBe('2\n');
    expect(script.stderr).toContain('PRODUCTION — NODE_ENV=production, db sqlite');
    expect(script.stderr).toContain('changes are rolled back at the end (--sandbox).');
    // Fail-closed (E139): staging is protected like production.
    const staging = bespoke(['tinker', '-e', '1 + 1'], { ...env, ...config, NODE_ENV: 'staging' });
    expect(staging.stderr).toContain('PROTECTED (staging) — NODE_ENV=staging, db sqlite');
  });

  it('keeps a history in storage/framework/tinker_history only for the owner — none with --no-history', async () => {
    // The history belongs to the app root (here the web app's storage/, which git ignores); a developer's own history stays.
    const history = join(webApp, 'storage/framework/tinker_history');
    const existed = existsSync(history);
    await session([], env, '1 + 1\n.exit\n');
    expect(existsSync(history)).toBe(true);
    expect(statSync(history).mode & 0o777).toBe(0o600);
    if (!existed) rmSync(history);
  });
});

describe.runIf(PGSQL_URL)('bespoke tinker --sandbox on Postgres', { timeout: 60_000 }, () => {
  const database = 'bespoke_tinker_test';
  const url = new URL(PGSQL_URL ?? 'postgres://localhost');
  const admin = { DB_CONNECTION: 'pgsql', DB_URL: url.href };
  const env = { DB_CONNECTION: 'pgsql', DB_URL: Object.assign(new URL(url.href), { pathname: `/${database}` }).href };
  const recreate = `const { sql } = await import('@bespokecore/database'); await sql.raw('drop database if exists ${database}').execute(db);`;

  beforeAll(() => {
    expect(bespoke(['tinker', '-e', `${recreate} await sql.raw('create database ${database}').execute(db)`], admin).code).toBe(0);
    const fresh = bespoke(['migrate:fresh', '--seed', '--no-types'], env);
    expect(fresh.code, fresh.stderr).toBe(0);
  });
  afterAll(() => bespoke(['tinker', '-e', recreate], admin));

  it('rolls back, and a failed statement takes back only its own input', async () => {
    const before = Number(bespoke(['tinker', '-e', 'await repos.users.count()'], env).stdout);
    const insert = `await repos.users.insert({ name: 'Tinker', email: 'tinker@example.com', password: 'x', locale: 'en' })`;
    const { stdout } = await session(['--sandbox', '--no-history'], env, [`${insert}; 'first'`, `${insert}; 'twice'`, '`users:${await repos.users.count()}`', '.exit', ''].join('\n'));
    expect(stdout).toContain("'first'");
    expect(stdout).toMatch(/Uncaught:?\s+error: duplicate key value violates unique constraint "users_email_unique"/);
    // On Postgres a failed statement aborts the whole transaction — the input's savepoint keeps the session usable.
    expect(stdout).toContain(`'users:${before + 1}'`);
    expect(stdout).toContain(`db pgsql (${url.host}/${database})`);
    expect(stdout).not.toContain(url.password || 'never');
    expect(Number(bespoke(['tinker', '-e', 'await repos.users.count()'], env).stdout)).toBe(before);
  });
});
