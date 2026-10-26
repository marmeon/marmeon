import { generateKey } from '@marmeon/encryption';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, webApp, webAppCopy } from './__fixtures__/cli.js';

describe('marmeon (in the web app)', () => {
  it('lists commands grouped by namespace', () => {
    const { code, stdout } = marmeon(webApp, []);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^ {2}dev\s+Start the development server/m);
    expect(stdout).toMatch(/^make\n(?: {2}make:.*\n)+/m);
    expect(stdout).toContain('route:list');
    expect(stdout).toContain('db:show');
    expect(stdout).not.toMatch(/^ {2}serve\b/m); // internal
  });

  it('lists routes through a command that gets the Router injected', () => {
    const { code, stdout } = marmeon(webApp, ['route:list']);
    expect(code).toBe(0);
    // Execution order: global first, then the web group (cookies before the session), the route's own last.
    expect(stdout).toMatch(
      /GET\s+\/users\/:user\s+user-profile\.show\s+web\s+SecurityHeaders, ContentSecurityPolicy, LimitLiveValidation, EncryptCookies, ClearClientHistory, StartSession, NoStoreWhenSignedIn, .*ShareAppProps, authenticate, verified\s+everyone \(public: user\)\s+ShowUserProfileController/,
    );
    expect(stdout).toMatch(/GET\s+\/api\/users\s+api\.users\.index\s+api\s+SecurityHeaders, ContentSecurityPolicy, LimitLiveValidation, authenticate:api, abilities:users:read\s+everyone\s+ListUsersController/);
    expect(stdout).toMatch(/\n\d+ routes\n$/); // the count grows with the app
  });

  it('shows who may call each route: a policy check, everyone for an open one, framework for the framework’s own (none: route-list.test.ts)', () => {
    const { stdout } = marmeon(webApp, ['route:list']);
    expect(stdout).toMatch(/^METHOD\s+PATH\s+NAME\s+GROUP\s+MIDDLEWARE\s+ACCESS\s+ACTION$/m);
    expect(stdout).toMatch(/PUT\s+\/users\/:user\s+user-profile\.update\s.*\scan ProfilePolicy\.update\(user\)\s+UpdateUserProfileController/);
    expect(stdout).toMatch(/GET\s+\/users\/:user\s+user-profile\.show\s.*\severyone \(public: user\)\s+ShowUserProfileController/);
    expect(stdout).toMatch(/GET\s+\/_marmeon\/live\s.*\sframework\s+LiveStreamController/);
  });

  it('names the bindings that make records public, in the table and in the JSON', () => {
    const routes = JSON.parse(marmeon(webApp, ['route:list', '--json']).stdout) as { routes: { path: string; methods: string[]; publicBindings: string[] }[] };
    expect(routes.routes.find((route) => route.path === '/users/:user' && route.methods.includes('GET'))?.publicBindings).toEqual(['user']);
    expect(routes.routes.find((route) => route.path === '/users/:user' && route.methods.includes('PUT'))?.publicBindings).toEqual([]);
  });

  it('prints route:list and list as one JSON document with the format first', () => {
    const routes = marmeon(webApp, ['route:list', '--json']);
    expect(routes.code).toBe(0);
    expect(Object.keys(JSON.parse(routes.stdout))[0]).toBe('format');
    expect(JSON.parse(routes.stdout)).toMatchObject({ format: 1, warnings: [] });
    const list = marmeon(webApp, ['list', '--json']);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ format: 1, complete: true });
    expect(JSON.parse(list.stdout).commands.find((command: { name: string }) => command.name === 'dev')).toMatchObject({ launcher: true });
  });

  it('lists the built-in commands as incomplete when the app does not load, with the reason in the document and nothing on stderr', () => {
    const { code, stdout, stderr } = marmeon(webApp, ['list', '--json'], { APP_NAME: '', APP_URL: 'localhost' });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const document = JSON.parse(stdout) as { complete: boolean; warnings: string[] };
    expect(document.complete).toBe(false);
    expect(document.warnings).toHaveLength(1);
  });

  it('writes nothing to stdout when a command fails with --json', () => {
    const { code, stdout, stderr } = marmeon(webApp, ['route:list', '--json'], { APP_NAME: '', APP_URL: 'localhost' });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Invalid configuration');
  });

  it('prints schedule:list and db:show as one JSON document each, and nothing on stdout when they fail', () => {
    const schedule = marmeon(webApp, ['schedule:list', '--json']);
    expect(schedule.code).toBe(0);
    const tasks = JSON.parse(schedule.stdout) as { format: number; tasks: { name: string; next: string | null; options: object }[]; warnings: string[] };
    expect(Object.keys(tasks)).toEqual(['format', 'tasks', 'warnings']);
    expect(tasks.tasks.find((task) => task.name === 'session:prune')).toMatchObject({ expression: '*/15 * * * *', options: { oneServer: true, catchUp: 'once', environments: null, filtered: false } });
    expect(tasks.tasks.every((task) => task.next === null || /^\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d$/.test(task.next))).toBe(true);
    const database = marmeon(webApp, ['db:show', '--json']);
    expect(database.code).toBe(0);
    expect(Object.keys(JSON.parse(database.stdout))).toEqual(['format', 'connection', 'driver', 'target', 'server', 'tables', 'warnings']);
    expect(JSON.parse(database.stdout)).toMatchObject({ format: 1, connection: 'default', driver: 'sqlite', warnings: [] });
    for (const command of ['schedule:list', 'db:show']) {
      const failed = marmeon(webApp, [command, '--json'], { APP_NAME: '', APP_URL: 'localhost' });
      expect(failed.code, command).toBe(1);
      expect(failed.stdout, command).toBe('');
      expect(failed.stderr, command).toContain('Invalid configuration');
    }
  });

  it('does not print the password of DB_URL when db:show is called with a Postgres address that cannot be reached', () => {
    const { stdout, stderr } = marmeon(webApp, ['db:show', '--json'], { DB_DRIVER: 'pgsql', DB_URL: 'postgres://u:geheim@127.0.0.1:1/db?sslkey=/marmeon-secret-key.pem&password=geheim2' }, 20_000);
    expect(stdout).toBe('');
    expect(stdout + stderr).not.toMatch(/geheim|marmeon-secret-key/);
    expect(stderr).toContain('a certificate or key file named in the URL');
  });

  it('prints configuration errors without Node internals and exits with 1', () => {
    const { code, stderr } = marmeon(webApp, ['route:list'], { APP_NAME: '', APP_URL: 'localhost' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ \[marmeon:K6\] Invalid configuration — the application cannot start:\n {2}• app: APP_NAME/);
    expect(stderr).not.toMatch(/triggerUncaughtException|node:internal/);
  });

  it('says how to fix an error the app cannot start with — the solutions as text', () => {
    const { code, stdout } = marmeon(webApp, ['route:list'], { APP_KEY: '' });
    expect(code).toBe(1);
    // The installed package's solution (encryption) first, then the core's.
    expect(stdout).toContain('How to fix it (K6): Generate an application key');
    expect(stdout).toContain('  $ marmeon key:generate');
    expect(stdout).toContain('  docs: docs/configuration.md#when-a-value-is-wrong');
    expect(stdout).toContain('How to fix it (K6): Set APP_KEY in .env');
  });

  it('shows the database connection (db:show, added by @marmeon/database)', () => {
    const { code, stdout } = marmeon(webApp, ['db:show'], { DB_DATABASE: ':memory:' });
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Connection {2}default\nTarget {6}sqlite :memory:\nServer {6}SQLite 3\.\d+/m);
    expect(stdout).toContain('No tables yet.');
  });

  it('runs the modules’ migrations in timestamp order (migrate, migrate:status)', () => {
    const memory = { DB_DATABASE: ':memory:' }; // every process starts empty
    const status = marmeon(webApp, ['migrate:status'], memory);
    expect(status.stdout).toMatch(
      /2026_10_01_120000_create_users_table\s+auth\s+Pending\n2026_10_01_120100_create_login_activity_table\s+user-profile\s+Pending\n2026_10_01_120101_create_profile_links_table\s+user-profile\s+Pending/,
    );
    const migrate = marmeon(webApp, ['migrate'], memory);
    expect(migrate.code).toBe(0);
    // Every module's migrations, in timestamp order (the list grows with the app) …
    const ran = [...migrate.stdout.matchAll(/^✓ Migrated (\d{4}_\d\d_\d\d_\d{6}_\w+) \(([\w-]+)\) [\d.]+ ms$/gm)].map((match) => match[1]!);
    expect(ran.slice(0, 3)).toEqual(['2026_10_01_120000_create_users_table', '2026_10_01_120100_create_login_activity_table', '2026_10_01_120101_create_profile_links_table']);
    expect(ran).toEqual(ran.toSorted());
    // It names the environment it assumed — and a test writes no table types (development only).
    expect(migrate.stdout).toMatch(/^Environment: test \(APP_ENV=testing\)\n/);
    expect(migrate.stdout).not.toContain('database.d.ts');
  });

  it('prints migrate:status as one JSON document, and nothing on stdout when the record of migrations is of a newer form', () => {
    const database = join(tempDir('marmeon-migrate-status-'), 'database.sqlite');
    const env = { DB_DATABASE: database };
    const pending = marmeon(webApp, ['migrate:status', '--json'], env);
    expect(pending.code).toBe(0);
    const before = JSON.parse(pending.stdout) as { format: number; migrations: { name: string; batch: number | null; status: string }[]; warnings: string[] };
    expect(Object.keys(before)).toEqual(['format', 'migrations', 'warnings']);
    expect(before.migrations.length).toBeGreaterThan(2);
    expect(before.migrations.every((m) => m.batch === null && m.status === 'pending')).toBe(true);

    expect(marmeon(webApp, ['migrate'], env).code).toBe(0);
    const after = JSON.parse(marmeon(webApp, ['migrate:status', '--json'], env).stdout) as typeof before;
    expect(after.migrations.map((m) => m.name)).toEqual(before.migrations.map((m) => m.name));
    expect(after.migrations.every((m) => m.batch === 1 && m.status === 'ran')).toBe(true);

    const connection = new DatabaseSync(database);
    connection.exec('alter table migrations add column note varchar(64)');
    connection.close();
    const newer = marmeon(webApp, ['migrate:status', '--json'], env);
    expect(newer.code).toBe(1);
    expect(newer.stdout).toBe('');
    expect(newer.stderr).toContain('[marmeon:D1]');
  });

  it('asks for --force wherever the app is protected — APP_ENV=local on production too — and writes table types in development only', () => {
    const memory = { DB_DATABASE: ':memory:' };
    // Outside NODE_ENV=test the app reads .env, which CI does not have: what it needs to boot comes from here.
    const key = generateKey(); // not .env.test's: that key is public and production refuses it
    const config = { ...memory, SYSTEM_DB_DATABASE: ':memory:', APP_NAME: 'Marmeon', APP_URL: 'http://localhost', APP_KEY: key, DEVTOOLS_ENABLED: 'false' };
    // Development regenerates the table types (already committed, so unchanged) — in a copy: other tests read the app's.
    const development = marmeon(webAppCopy(), ['migrate'], { ...config, NODE_ENV: 'development' });
    expect(development.stdout).toMatch(/ℹ bootstrap\/database\.d\.ts is up to date\.\n$/);
    expect(marmeon(webApp, ['migrate:fresh'], { ...config, NODE_ENV: 'production' }).stderr).toContain('The application is protected (production (APP_ENV=production)). Pass --force to drop every table — or, on a development machine, set NODE_ENV=development (in .env or the environment).');
    // APP_ENV names the environment and protects or opens nothing: APP_ENV=local on production asks for --force; with it,
    // it migrates — and writes no types (development only).
    const local = marmeon(webApp, ['migrate'], { ...config, NODE_ENV: 'production', APP_ENV: 'local' });
    expect(local.code, 'APP_ENV=local on production migrated without --force').toBe(1);
    expect(local.stdout).toContain('Environment: production (APP_ENV=local)\n');
    expect(local.stdout).not.toContain('Migrated');
    expect(local.stderr).toContain('Pass --force to migrate — or, on a development machine, set NODE_ENV=development (in .env or the environment).');
    // Any other NODE_ENV stops before the app loads — with the way to name a staging server.
    const staging = marmeon(webApp, ['migrate', '--force'], { ...config, NODE_ENV: 'staging' });
    expect(staging.code).toBe(1);
    expect(staging.stdout).toBe('');
    expect(staging.stderr).toBe(
      '✗ [marmeon:K6] Invalid environment — the application cannot start:\n  • NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging. ' +
        'NODE_ENV is development, test or production; APP_ENV names the environment (docs/configuration.md#the-environment-node_env).\n',
    );
    const forced = marmeon(webApp, ['migrate', '--force'], { ...config, NODE_ENV: 'production', APP_ENV: 'staging' });
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('Migrated 2026_10_01_120000_create_users_table');
    expect(forced.stdout).not.toContain('database.d.ts');
  });

  it('migrates from scratch and seeds (migrate:fresh --seed, db:seed)', () => {
    const fresh = marmeon(webApp, ['migrate:fresh', '--seed', '--no-types'], { DB_DATABASE: ':memory:' });
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toMatch(/✓ Seeded DemoUsersSeeder \(auth\) [\d.]+ ms\n✓ Seeded DemoLinksSeeder \(user-profile\) [\d.]+ ms\n$/);
    const unknown = marmeon(webApp, ['db:seed', '--class=Nope'], { DB_DATABASE: ':memory:' });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe('✗ [marmeon:D13] There is no seeder "Nope".\n');
  });

  it('checks that the committed table types match the migrations (db:types --check, as in CI)', () => {
    const { code, stdout } = marmeon(webApp, ['db:types', '--check'], { DB_DATABASE: ':memory:' });
    expect(stdout).toContain('✓ bootstrap/database.d.ts matches the migrations.');
    expect(code).toBe(0);
  });

  it('checks that the committed route types match the routes and views (route:types --check, as in CI)', () => {
    const { code, stdout } = marmeon(webApp, ['route:types', '--check']);
    expect(stdout).toContain('✓ bootstrap/routes.ts matches the routes and views.');
    expect(code).toBe(0);
  });

  it('writes the route types without a secret — route:types registers the app and boots nothing, as marmeon build runs it', () => {
    // What a Docker build has: no .env of the app's (CI has none anyway), no key, no name — here emptied over whatever .env holds.
    const withoutSecrets = { NODE_ENV: 'production', APP_KEY: '', APP_PREVIOUS_KEYS: '', APP_NAME: '', APP_URL: '' };
    const types = marmeon(webApp, ['route:types', '--check'], withoutSecrets);
    expect(types.stderr).not.toContain('Invalid configuration');
    expect(types.stdout).toContain('✓ bootstrap/routes.ts matches the routes and views.');
    expect(types.code).toBe(0);
    // A command that runs the app still needs them.
    const list = marmeon(webApp, ['route:list'], withoutSecrets);
    expect(list.code).toBe(1);
    expect(list.stderr).toContain('Invalid configuration — the application cannot start:\n  • app: APP_NAME');
  });

  it('prints a failing command’s error without Node’s dump and exits with 1', () => {
    const { code, stdout, stderr } = marmeon(webApp, ['db:show'], { DB_DRIVER: 'pgsql', DB_URL: 'postgres://app:hunter2@127.0.0.1:1/app' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ DatabaseConnectionError: \[marmeon:D11\] Could not connect to the database connection "default" \(pgsql postgres:\/\/app:\*\*\*@127\.0\.0\.1:1\/app\): .*ECONNREFUSED.*\n {2}at /);
    expect(stderr).not.toMatch(/\[cause\]|hunter2|Node\.js v/);
    expect(stdout).toBe('');
  });

  it('prints a command’s description, usage and options for --help, without running it', () => {
    const help = marmeon(webApp, ['make:controller', '--help']);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('Usage: marmeon make:controller <Name> --module=<module> [--view] [--request]');
    expect(help.stdout).toMatch(/^Options:\n {2}-m, --module=<value>\n {2}--force\n {2}--view\n {2}--request\n {2}--no-interaction +Ask no questions.*\n {2}-h, --help +Show this help$/m);
    // An app command (the app boots to know it), with -h; after -- it is an argument, not the help.
    const short = marmeon(webApp, ['route:list', '-h']);
    expect(short.code).toBe(0);
    expect(short.stdout).toMatch(/^List all registered routes|^Usage: marmeon route:list/m);
    expect(marmeon(webApp, ['route:list', '--', '--help']).stdout).not.toContain('Usage: marmeon route:list');
  });

  it('exits with 2 for a wrong call of help and list, and for a wrong call of dev that would wait for changes', () => {
    expect(marmeon(webApp, ['help', 'nope']).code).toBe(2);
    expect(marmeon(webApp, ['list', '--nope']).code).toBe(2);
    expect(marmeon(webApp, ['help', 'route:list', '--json']).code).toBe(2);
    // Built-in options are checked before the app boots, so missing secrets do not hide the wrong call.
    expect(marmeon(webApp, ['route:list', '--nope'], { NODE_ENV: 'production', APP_KEY: '', APP_PREVIOUS_KEYS: '', APP_NAME: '', APP_URL: '' }).code).toBe(2);
    // An app that does not boot cannot say whether `migrate` exists: not a wrong call.
    expect(marmeon(webApp, ['help', 'migrate'], { APP_NAME: '', APP_URL: 'localhost' }).code).toBe(1);
    const help = marmeon(webApp, ['help', 'route:list']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: marmeon route:list [--json]');
    expect(marmeon(webApp, ['key:generate', '--help']).stdout).toContain('Usage: marmeon key:generate [--show] [--force]');
    // Under `node --watch` the launcher would wait for changes: it must end on its own.
    const dev = marmeon(webApp, ['dev', '--nope'], {}, 20_000);
    expect(dev.code).toBe(2);
    expect(dev.stderr).toContain('Usage: marmeon dev');
  });

  it('rejects unknown commands and invalid options', () => {
    const unknown = marmeon(webApp, ['nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Command "nope" is not defined');
    const invalid = marmeon(webApp, ['route:list', '--verbose']);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("Unknown option '--verbose'");
    expect(marmeon(webApp, ['route:list', '--nope']).code).toBe(2);
    // A string option without its value is a wrong call as well.
    const missing = marmeon(webApp, ['db:show', '--database'], { DB_DATABASE: ':memory:' });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/argument missing/i);
  });
});

describe('marmeon console log lines', () => {
  /** A copy of the web app whose own provider logs through the console logger while it boots. */
  function appThatLogsWhileBooting(): string {
    const app = webAppCopy();
    writeFileSync(
      join(app, 'bootstrap', 'LoudProvider.ts'),
      [
        "import { ConsoleLogger } from '@marmeon/core';",
        'export class LoudProvider {',
        '  register(): void {',
        "    const logger = new ConsoleLogger({ channel: 'loud' });",
        "    logger.info('loud boot');",
        "    logger.debug('loud debug');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const entry = join(app, 'bootstrap', 'app.ts');
    writeFileSync(
      entry,
      readFileSync(entry, 'utf8')
        .replace("import { AppConfig }", "import { LoudProvider } from './LoudProvider.ts';\nimport { AppConfig }")
        .replace('  modules: [', '  providers: [LoudProvider],\n  modules: ['),
    );
    return app;
  }

  it('sends them to stderr while the command prints JSON, so stdout is one document', () => {
    const { code, stdout, stderr } = marmeon(appThatLogsWhileBooting(), ['route:list', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ format: 1 });
    expect(stdout).not.toContain('loud boot');
    expect(stderr).toContain('[info] loud boot');
    expect(stderr).toContain('[debug] loud debug');
    expect(stdout).not.toContain('loud debug');
  });

  it('keeps info on stdout without --json', () => {
    const { code, stdout, stderr } = marmeon(appThatLogsWhileBooting(), ['route:list']);
    expect(code).toBe(0);
    expect(stdout).toContain('[info] loud boot');
    expect(stdout).toContain('[debug] loud debug');
    expect(stderr).not.toContain('loud boot');
  });

  it('sends the app logger’s (pino) lines to stderr too, in both formats', () => {
    for (const format of ['json', 'pretty']) {
      const app = webAppCopy();
      const entry = join(app, 'bootstrap', 'app.ts');
      writeFileSync(join(app, 'bootstrap', 'PinoProvider.ts'), [
        "import { Logger } from '@marmeon/core';",
        'export class PinoProvider {',
        '  boot(app: { container: { make(token: unknown): Logger } }): void {',
        "    app.container.make(Logger).info('pino boot');",
        '  }',
        '}',
        '',
      ].join('\n'));
      writeFileSync(
        entry,
        readFileSync(entry, 'utf8')
          .replace("import { AppConfig }", "import { PinoProvider } from './PinoProvider.ts';\nimport { AppConfig }")
          .replace('  modules: [', '  providers: [PinoProvider],\n  modules: ['),
      );
      const { code, stdout, stderr } = marmeon(app, ['route:list', '--json'], { LOG_LEVEL: 'info', LOG_FORMAT: format });
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ format: 1 });
      expect(stderr).toContain('pino boot');
      const plain = marmeon(app, ['route:list'], { LOG_LEVEL: 'info', LOG_FORMAT: format });
      expect(plain.stdout).toContain('pino boot');
    }
  });
});
