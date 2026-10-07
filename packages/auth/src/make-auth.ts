import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandInput } from 'marmeon';

/**
 * The module templates, per UI adapter (E30): `stubs/<adapter>/modules/auth`. One set: its registration and change of address are
 * private by default and say "taken" with `AUTH_PRIVATE_REGISTRATION=false` (E146, E193) — decided at run time, not here.
 */
export const STUBS = fileURLToPath(new URL('../stubs/', import.meta.url));

/**
 * What the generated module imports — reported when the app lacks it (the fixture test checks the list against every import
 * of the templates). `mjml` is the mail package's optional peer behind the templates' `mjml` mails. `marmeon` runs the
 * module in production — `marmeon start`, the worker its mails go through, the scheduler that prunes its tokens (E159) — so
 * it is a dependency, never a dev dependency.
 */
export const NEEDED = [
  '@marmeon/auth',
  '@marmeon/cache',
  'marmeon',
  '@marmeon/core',
  '@marmeon/database',
  '@marmeon/http',
  '@marmeon/i18n',
  '@marmeon/mail',
  '@marmeon/queue',
  '@marmeon/react',
  '@marmeon/router',
  '@marmeon/scheduler',
  '@marmeon/session',
  '@marmeon/validation',
  'mjml',
  'react',
];

/** What only the module's tests import — reported as dev dependencies. */
export const NEEDED_FOR_TESTS = ['@marmeon/testing', 'vitest'];

/** What `make:auth --private-registration` says since the flag is gone (E193) — the module is made all the same. */
export const PRIVATE_REGISTRATION_FLAG_GONE =
  '--private-registration is gone: private registration is the default now — the module never tells whether an address has an ' +
  'account. Set AUTH_PRIVATE_REGISTRATION=false in .env to turn it off.';

/**
 * `marmeon make:auth` (Laravel Breeze): writes a complete auth module into the app — sign-in, registration,
 * remember-me, password reset, e-mail verification, password confirmation, API tokens, with views,
 * mails, migrations and tests. The code belongs to the app from then on; the mechanics stay in
 * @marmeon/auth.
 */
export class MakeAuthCommand {
  static command = 'make:auth';
  static description = 'Create the auth module (sign-in, registration, reset, verification, API tokens) — yours to change';
  static usage = '[--adapter=react] [--force]';
  // `private-registration` only to name what replaced it (E193): the module is private by default, the switch lives in the env.
  static options = { force: { type: 'boolean' }, adapter: { type: 'string' }, 'private-registration': { type: 'boolean' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const adapter = typeof input.options.adapter === 'string' ? input.options.adapter : 'react';
    const source = join(STUBS, adapter, 'modules', 'auth');
    if (!/^[a-z]+$/.test(adapter) || !existsSync(source)) {
      input.output.error(`There are no auth templates for the UI adapter "${adapter}". Known: ${readdirSync(STUBS).join(', ')}.`);
      return 1;
    }
    const target = join(input.root, 'modules', 'auth');
    if (existsSync(target) && input.options.force !== true) {
      input.output.error('modules/auth already exists. It is yours now — pass --force to overwrite it with the templates.');
      return 1;
    }
    if (!existsSync(join(input.root, 'config', 'app.ts'))) {
      input.output.error('The templates need config/app.ts exporting AppConfig (APP_NAME, APP_URL) — the app skeleton has one.');
      return 1;
    }

    if (input.options['private-registration'] !== undefined) input.output.warn(PRIVATE_REGISTRATION_FLAG_GONE);

    cpSync(source, target, { recursive: true, force: true });
    const files = (readdirSync(target, { recursive: true }) as string[]).filter((file) => /\.\w+$/.test(file));
    input.output.success(`Created modules/auth (${files.length} files)`);

    const registered = register(join(input.root, 'bootstrap', 'app.ts'));
    if (registered === 'added') input.output.success('Registered the module in bootstrap/app.ts');
    else if (registered === 'manual') {
      input.output.line('Register the module in bootstrap/app.ts:');
      input.output.line("  import auth from '#modules/auth';");
      input.output.line('  modules: [auth, …]');
    }

    const missing = missingDependencies(input.root);
    const runtime = missing.filter((name) => NEEDED.includes(name));
    const forTests = missing.filter((name) => NEEDED_FOR_TESTS.includes(name));
    // A dev dependency is gone after `pnpm install --prod` (a Docker image): what the module runs with belongs in `dependencies`.
    const lists = dependencyLists(input.root);
    const devOnly = NEEDED.filter((name) => name in (lists.devDependencies ?? {}) && !(name in (lists.dependencies ?? {})));
    // The module's routes and views into bootstrap/routes.ts — a fresh process, as this one booted without the module.
    const typed = runtime.length === 0 && registered !== 'manual' && (await input.spawn('route:types')) === 0;
    input.output.line();
    if (runtime.length > 0) input.output.line(`Install what the module uses: pnpm add ${runtime.join(' ')}`);
    if (forTests.length > 0) input.output.line(`And what its tests use: pnpm add -D ${forTests.join(' ')}`);
    if (devOnly.length > 0) input.output.line(`Production needs these as dependencies, not dev dependencies: pnpm add ${devOnly.join(' ')}`);
    if (!typed) input.output.line('Then: marmeon route:types — it writes the routes and views of the module into bootstrap/routes.ts.');
    input.output.line('Then: marmeon migrate (with NODE_ENV=development — .env.example sets it — it writes the table types) — and set MAIL_* in .env (development writes mails to the log).');
    input.output.line('Its mails go through the queue, on its "mail" queue: a jobs table (marmeon make:queue-table, once) and a worker (marmeon dev starts one; in production: marmeon queue:work, which takes every queue).');
    input.output.line('Expired tokens are pruned at night by the scheduler (marmeon dev starts it; in production: marmeon schedule:work or schedule:run from cron).');
    input.output.line('Registration and the change of address are private: they never tell whether an address has an account (AUTH_PRIVATE_REGISTRATION=false makes them say "taken").');
    input.output.line(`Tests: ${relative(input.root, join(target, 'auth.test.ts'))}`);
    // The lint preset and the devtools belong to the app, not to the module (W7.6) — named when the app has neither yet.
    if (!existsSync(join(input.root, '.oxlintrc.json'))) {
      input.output.line('Lint: marmeon make:lint-config writes the app\'s preset (views import controllers only with import type).');
    }
    if (!('@marmeon/devtools' in installed(input.root))) {
      input.output.line('Devtools for marmeon dev (requests, queries, jobs, mails at /_marmeon/devtools): pnpm add -D @marmeon/devtools');
    }
    // The Content-Security-Policy belongs to the app's middleware too (E147) — named when bootstrap/app.ts has none.
    const bootstrap = join(input.root, 'bootstrap', 'app.ts');
    if (existsSync(bootstrap) && !readFileSync(bootstrap, 'utf8').includes('contentSecurityPolicy(')) {
      input.output.line("Content-Security-Policy: add contentSecurityPolicy() of @marmeon/http to the app's global middleware (a nonce per page, E147).");
    }
    return 0;
  }
}

/** Adds `auth` to `modules: [...]` of the application definition — or says it cannot. */
function register(file: string): 'added' | 'present' | 'manual' {
  if (!existsSync(file)) return 'manual';
  const source = readFileSync(file, 'utf8');
  if (/from '#modules\/auth'/.test(source)) return 'present';
  const modules = /modules:\s*\[([^\]]*)\]/.exec(source);
  const imports = [...source.matchAll(/^import .*;$/gm)];
  if (!modules || imports.length === 0) return 'manual';
  const lastImport = imports.at(-1)!;
  const list = modules[1]!.trim();
  let patched = source.replace(modules[0], `modules: [${list ? `auth, ${list}` : 'auth'}]`);
  const at = lastImport.index + lastImport[0].length;
  patched = `${patched.slice(0, at)}\nimport auth from '#modules/auth';${patched.slice(at)}`;
  writeFileSync(file, patched);
  return 'added';
}

function missingDependencies(root: string): string[] {
  if (!existsSync(join(root, 'package.json'))) return [...NEEDED, ...NEEDED_FOR_TESTS];
  const have = installed(root);
  return [...NEEDED, ...NEEDED_FOR_TESTS].filter((name) => !(name in have));
}

/** The app's dependencies and dev dependencies (none without a package.json). */
function installed(root: string): Record<string, string> {
  const pkg = dependencyLists(root);
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

function dependencyLists(root: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
}
