import { cpSync, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_STUBS } from '@marmeon/auth/internal';
import { CommandArgumentsError, editDefinitionFile, importedBindings } from '@marmeon/core';
import { escapesRoot, readStubManifest, recordStubSet, removeLeftovers, STUB_MANIFEST } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';

/** The module templates, per UI adapter: `stubs/<adapter>/modules/oauth`. The `migrations` directory beside them holds the table's migration, which `marmeon publish @marmeon/oauth` copies from the installed package. */
export const STUBS = fileURLToPath(new URL('../stubs/', import.meta.url));

/**
 * What the generated module imports — reported when the app lacks it (the fixture test checks the list against every import of the
 * templates). `@marmeon/fetch` is not imported by a template (the test checks one direction: every import is
 * listed): the providers' requests go through its `HttpClient`, so an app that signs in at a provider has it. `mjml` is the mail package's optional peer behind the module's `mjml` mail, and `marmeon` runs the worker that
 * sends it — a dependency, never a dev dependency.
 */
export const NEEDED = [
  '@marmeon/auth',
  '@marmeon/cache',
  '@marmeon/core',
  '@marmeon/fetch',
  '@marmeon/http',
  '@marmeon/i18n',
  '@marmeon/mail',
  '@marmeon/oauth',
  '@marmeon/queue',
  '@marmeon/react',
  '@marmeon/router',
  '@marmeon/session',
  '@marmeon/validation',
  'marmeon',
  'mjml',
];

/** What only the module's tests import — reported as dev dependencies. */
export const NEEDED_FOR_TESTS = ['@marmeon/database', '@marmeon/testing', 'vitest'];

/** The names for `pnpm add -E`: a framework package in the version of the app (they must all be one), anything else as it is. */
const exact = (names: readonly string[]) => names.map((name) => (name === 'marmeon' || name.startsWith('@marmeon/') ? `${name}@<version of your app>` : name)).join(' ');

/** The name of a migration without its timestamp and extension: what the migrator knows it by, whatever timestamp a copy carries. */
const MIGRATION_FILE = /^\d{4}_\d{2}_\d{2}_\d{6}_([a-z][a-z0-9_]*)\.(?:ts|js|mts|mjs)$/;

/** The kit's migration that lets `users.password` be empty — an account that signs in at a provider has no password. */
const PASSWORD_OPTIONAL = 'make_users_password_optional';

/**
 * `marmeon make:oauth`: writes the oauth module into the app — the sign-in island with one button per active provider, the routes that
 * start and complete a sign-in, the bridge to the app's users, the texts and a test. The code belongs to the app from then on; the
 * mechanics stay in @marmeon/oauth. See docs/oauth.md#the-generated-module.
 */
export class MakeOAuthCommand {
  static command = 'make:oauth';
  static description = 'Create the oauth module (sign in with GitHub, Google and other providers) — yours to change';
  static usage = '[--adapter=react] [--force]';
  static options = { force: { type: 'boolean' }, adapter: { type: 'string' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const adapter = typeof input.options.adapter === 'string' ? input.options.adapter : 'react';
    const source = join(STUBS, adapter, 'modules', 'oauth');
    if (!/^[a-z]+$/.test(adapter) || !existsSync(source)) {
      throw new CommandArgumentsError(`There are no oauth templates for the UI adapter "${adapter}". Known: ${readdirSync(STUBS).filter((name) => name !== 'migrations').join(', ')}.`);
    }
    const target = join(input.root, 'modules', 'oauth');
    if (existsSync(target) && input.options.force !== true) {
      input.output.error('modules/oauth already exists. It is yours now — pass --force to overwrite it with the templates.');
      return 1;
    }
    if (!existsSync(join(input.root, 'config', 'app.ts'))) {
      input.output.error('The templates need config/app.ts exporting AppConfig (APP_NAME, APP_URL) — the app skeleton has one.');
      return 1;
    }

    // No write goes through a link out of the project (a cloned repository can carry one): every path the command writes is checked
    // before the first write. They are the module's files, the one registration in bootstrap/app.ts and the manifest — nothing else of the app.
    const written = [...(readdirSync(source, { recursive: true }) as string[]).map((file) => join(target, file)), join(input.root, 'bootstrap', 'app.ts'), join(input.root, STUB_MANIFEST)];
    for (const path of written) {
      const link = escapesRoot(input.root, path);
      if (link !== undefined) {
        input.output.error(`${link.split(sep).join('/')} leads out of the project, and make:oauth would write through it. Replace the link with a real file or directory, then run marmeon make:oauth again. Nothing was written.`);
        return 1;
      }
    }
    // `escapesRoot` refuses only a link that leaves the project. A link that stays inside it is refused as well: `cpSync` with `force` writes
    // through a link at its destination, so a link in the module (or at the two files it edits) would overwrite another file of the app.
    for (const path of [join(input.root, 'modules'), target, ...written]) {
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
        input.output.error(`${relative(input.root, path).split(sep).join('/')} is a link, and make:oauth would write through it. Replace the link with a real file or directory, then run marmeon make:oauth again. Nothing was written.`);
        return 1;
      }
    }
    // Read before anything is written: a manifest of a newer Marmeon is not ours to overwrite, and then the module is not either.
    const manifest = readStubManifest(input.root);
    if (!manifest.ok) {
      input.output.error(manifest.error.message);
      return 1;
    }

    cpSync(source, target, { recursive: true, force: true });
    const copied = (readdirSync(source, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(source, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .sort();
    input.output.success(`Created modules/oauth (${copied.length} files)`);
    const set = `@marmeon/oauth:${adapter}/modules/oauth`;
    removeLeftovers(input.root, 'oauth', manifest.value?.sets[set], copied.map((file) => `modules/oauth/${file}`), input.output);
    const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    const recorded = recordStubSet(input.root, set, {
      package: '@marmeon/oauth',
      version,
      files: copied.map((file) => ({ path: `modules/oauth/${file}`, stub: `stubs/${adapter}/modules/oauth/${file}` })),
    });
    if (recorded.ok) input.output.success(`Recorded the module's files in ${STUB_MANIFEST} (version ${version})`);
    else input.output.warn(recorded.error.message);

    const registered = register(join(input.root, 'bootstrap', 'app.ts'));
    if (registered.status === 'added') input.output.success('Registered the module in bootstrap/app.ts');
    else if (registered.status === 'manual') {
      if (registered.reason) input.output.warn(`Not registered — ${registered.reason}`);
      input.output.line('Register the module in bootstrap/app.ts:');
      input.output.line("  import oauth from '#modules/oauth';");
      input.output.line('  modules: [oauth, …]');
    }

    const missing = missingDependencies(input.root);
    const runtime = missing.filter((name) => NEEDED.includes(name));
    const forTests = missing.filter((name) => NEEDED_FOR_TESTS.includes(name));
    // A dev dependency is gone after `pnpm install --prod` (a Docker image): what the module runs with belongs in `dependencies`.
    const lists = dependencyLists(input.root);
    const devOnly = NEEDED.filter((name) => name in (lists.devDependencies ?? {}) && !(name in (lists.dependencies ?? {})));
    // The module's routes and views into bootstrap/routes.ts — a fresh process, as this one booted without the module.
    const typed = runtime.length === 0 && registered.status !== 'manual' && (await input.spawn('route:types')) === 0;
    input.output.line();
    if (runtime.length > 0) input.output.line(`Install what the module uses: pnpm add -E ${exact(runtime)}`);
    if (forTests.length > 0) input.output.line(`And what its tests use: pnpm add -E -D ${exact(forTests)}`);
    if (devOnly.length > 0) input.output.line(`Production needs these as dependencies, not dev dependencies: pnpm add -E ${exact(devOnly)}`);
    // The module's mail is a TSX view: the server compiles it with oxc-transform, `marmeon build` ahead of time. Not a framework package, so no exact version.
    if (!('oxc-transform' in installed(input.root))) input.output.line('And what compiles its mail view: pnpm add -D oxc-transform');
    if (!typed) input.output.line('Then: marmeon route:types — it writes the routes and views of the module into bootstrap/routes.ts.');
    input.output.line('Then: marmeon publish @marmeon/oauth, which copies the migration of the social_accounts table the installed package ships into modules/system/migrations, and marmeon migrate.');
    this.#passwordMigration(input, adapter);
    input.output.line('Place the buttons on your sign-in page with <Island route="oauth.sign-in" /> (a view of the module that owns that page): https://marmeon.com/docs/oauth#placing-the-components');
    input.output.line('Set the variables of each provider in .env, for GitHub: OAUTH_GITHUB_CLIENT_ID and OAUTH_GITHUB_CLIENT_SECRET, and APP_URL. The provider is sent back to APP_URL/auth/<provider>/callback — register that address with it.');
    input.output.line('modules/oauth/targets.ts (your route names) and modules/oauth/SocialUsers.ts (your users table and UserRepository) hold what the module assumes about your app: change them if yours differ.');
    input.output.line('Its note to the owner of an address goes through the queue, on its "mail" queue: a jobs table (marmeon make:queue-table, once) and a worker (marmeon dev starts one; in production: marmeon queue:work).');
    input.output.line(`Tests: ${relative(input.root, join(target, 'sign-in.test.ts'))}`);
    return 0;
  }

  /**
   * Accounts that sign in at a provider have no password, so `users.password` must be allowed to be empty. The kit's migration for that is
   * not written here — a migration belongs to the module that owns the users — and only named when no module has it.
   */
  #passwordMigration(input: CommandInput, adapter: string): void {
    const modules = join(input.root, 'modules');
    const has = (readdirSync(modules, { withFileTypes: true }).filter((entry) => entry.isDirectory())).some((entry) => {
      const migrations = join(modules, entry.name, 'migrations');
      const stat = lstatSync(migrations, { throwIfNoEntry: false });
      return stat?.isDirectory() === true && readdirSync(migrations).some((file) => MIGRATION_FILE.exec(file)?.[1] === PASSWORD_OPTIONAL);
    });
    if (has) return;
    const templates = join(AUTH_STUBS, adapter, 'modules', 'auth', 'migrations');
    const template = existsSync(templates) ? readdirSync(templates).find((file) => MIGRATION_FILE.exec(file)?.[1] === PASSWORD_OPTIONAL) : undefined;
    if (template === undefined) {
      input.output.warn(`No module has the migration ${PASSWORD_OPTIONAL} (users.password must be allowed to be empty), and this version of @marmeon/auth ships no template of it.`);
      return;
    }
    const path = join(templates, template);
    const shown = relative(input.root, path);
    input.output.line(`Accounts made with a provider have no password: copy ${shown.startsWith('..') || isAbsolute(shown) ? path : shown} into the migrations of the module that owns users — it is not written for you.`);
  }
}

/** Adds `oauth` to the end of `modules` of the application definition — or says why it cannot. */
function register(file: string): { status: 'added' | 'present' } | { status: 'manual'; reason?: string } {
  if (!existsSync(file)) return { status: 'manual' };
  // The one edit outside modules/oauth: the app must list a module to run it. Nothing else of the app is touched — not the sign-in page, not the
  // settings page — because where the buttons go is the app's decision; the module offers an island and the app places it.
  const edited = editDefinitionFile(file, {
    define: { name: 'defineApplication', from: '@marmeon/core' },
    key: 'modules',
    add: { element: (names) => names.oauth!, position: 'last' },
    imports: [{ name: 'oauth', from: '#modules/oauth', kind: 'default' }],
  }, 'bootstrap/app.ts');
  if (edited.status !== 'manual') return { status: edited.status };
  // A list the editor cannot read may still be the app's own, with the module imported by hand: that is registered.
  const binding = [...importedBindings(readFileSync(file, 'utf8'), 'bootstrap/app.ts').values()].find(
    (candidate) => candidate.from === '#modules/oauth' && candidate.imported === 'default' && !candidate.typeOnly,
  );
  return binding ? { status: 'present' } : { status: 'manual', reason: edited.reason };
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
