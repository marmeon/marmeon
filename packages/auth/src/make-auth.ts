import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandArgumentsError, editDefinitionFile, importedBindings } from '@marmeon/core';
import { escapesRoot, readStubManifest, recordStubSet, STUB_MANIFEST, stubHash } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';

/**
 * The module templates, per UI adapter: `stubs/<adapter>/modules/auth`. One set: its registration and change of address are
 * private by default and say "taken" with `AUTH_PRIVATE_REGISTRATION=false` — decided at run time, not here.
 */
export const STUBS = fileURLToPath(new URL('../stubs/', import.meta.url));

/**
 * What the generated module imports — reported when the app lacks it (the fixture test checks the list against every import
 * of the templates). `mjml` is the mail package's optional peer behind the templates' `mjml` mails. `marmeon` runs the
 * module in production — `marmeon start`, the worker its mails go through, the scheduler that prunes its tokens — so
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
export const NEEDED_FOR_TESTS = ['@marmeon/server', '@marmeon/testing', 'vitest'];

/** The names for `pnpm add -E`: a framework package in the version of the app (they must all be one), anything else as it is. */
const exact = (names: readonly string[]) => names.map((name) => (name === 'marmeon' || name.startsWith('@marmeon/') ? `${name}@<version of your app>` : name)).join(' ');

/**
 * `marmeon make:auth`: writes a complete auth module into the app — sign-in, registration, remember-me, password reset,
 * e-mail verification, password confirmation, API tokens, with views, mails, migrations and tests. The code belongs to the
 * app from then on; the mechanics stay in @marmeon/auth.
 */
export class MakeAuthCommand {
  static command = 'make:auth';
  static description = 'Create the auth module (sign-in, registration, reset, verification, API tokens) — yours to change';
  static usage = '[--adapter=react] [--force]';
  // The module is private by default; AUTH_PRIVATE_REGISTRATION=false turns it off at run time — no option for it.
  static options = { force: { type: 'boolean' }, adapter: { type: 'string' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const adapter = typeof input.options.adapter === 'string' ? input.options.adapter : 'react';
    const source = join(STUBS, adapter, 'modules', 'auth');
    if (!/^[a-z]+$/.test(adapter) || !existsSync(source)) {
      throw new CommandArgumentsError(`There are no auth templates for the UI adapter "${adapter}". Known: ${readdirSync(STUBS).filter((name) => name !== 'migrations').join(', ')}.`);
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

    // No write goes through a link out of the project (a cloned repository can carry one): every path the command writes is
    // checked before the first write.
    const written = [
      // The migrations are written exclusively (`wx`, which never follows a link); their directory is checked below.
      ...(readdirSync(source, { recursive: true }) as string[]).filter((file) => file !== 'migrations' && !file.startsWith(`migrations${sep}`)).map((file) => join(target, file)),
      join(input.root, 'bootstrap', 'client.tsx'),
      join(input.root, 'bootstrap', 'app.ts'),
      join(input.root, STUB_MANIFEST),
    ];
    for (const path of written) {
      const link = escapesRoot(input.root, path);
      if (link !== undefined) {
        input.output.error(`${link.split(sep).join('/')} leads out of the project, and make:auth would write through it. Replace the link with a real file or directory, then run marmeon make:auth again. Nothing was written.`);
        return 1;
      }
    }
    // Read before anything is written: a manifest of a newer Marmeon is not ours to overwrite, and then the module is not either.
    const manifest = readStubManifest(input.root);
    if (!manifest.ok) {
      input.output.error(manifest.error.message);
      return 1;
    }

    // A migration that ran never changes: --force writes the rest of the module again and only adds the migrations the app lacks.
    // Checked before the first write, so a refusal leaves the module as it was.
    const migrations = join(target, 'migrations');
    const entry = lstatSync(migrations, { throwIfNoEntry: false });
    if (entry !== undefined && !entry.isDirectory()) {
      input.output.error('modules/auth/migrations is a link or a file, not a directory of the app. Replace it with the directory, then run marmeon make:auth --force again. Nothing was written.');
      return 1;
    }
    const templates = join(source, 'migrations');
    cpSync(source, target, { recursive: true, force: true, filter: (path) => path !== templates && !path.startsWith(templates + sep) });
    const kept = copyMigrations(templates, migrations);
    if (kept.raced.length > 0) {
      for (const file of kept.raced) input.output.error(`modules/auth/migrations/${file} appeared while the migrations were written and was not overwritten.`);
      input.output.error('The rest of modules/auth was written again; marmeon-stubs.json was not updated. Run marmeon make:auth --force again.');
      return 1;
    }
    input.output.success(`Created modules/auth (${countFiles(target)} files)`);
    for (const file of kept.odd) input.output.warn(`modules/auth/migrations/${file} is no regular file; it counts as the migration and was kept.`);
    for (const file of kept.differs) input.output.info(`modules/auth/migrations/${file} differs from the template and was kept.`);
    if (kept.kept > 0) input.output.line(`Kept ${kept.kept} migrations in modules/auth/migrations: a migration that ran never changes; a change of a kit table comes as a new migration.`);
    // The migrations are append-only: a file of the framework never changes, a change comes as a new migration, so they are not recorded.
    // Listed from the templates, not from the target: with --force the app may hold files of its own next to them.
    const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    const copied = (readdirSync(source, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(source, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .filter((file) => !file.startsWith('migrations/'))
      .sort();
    removeLeftovers(input.root, manifest.value?.sets[`@marmeon/auth:${adapter}/modules/auth`], copied.map((file) => `modules/auth/${file}`), input.output);
    const recorded = recordStubSet(input.root, `@marmeon/auth:${adapter}/modules/auth`, {
      package: '@marmeon/auth',
      version,
      files: copied.map((file) => ({ path: `modules/auth/${file}`, stub: `stubs/${adapter}/modules/auth/${file}` })),
    });
    if (recorded.ok) input.output.success(`Recorded the module's files in ${STUB_MANIFEST} (version ${version})`);
    else input.output.warn(recorded.error.message);

    const registered = register(join(input.root, 'bootstrap', 'app.ts'));
    if (registered.status === 'added') input.output.success('Registered the module in bootstrap/app.ts');
    else if (registered.status === 'manual') {
      if (registered.reason) input.output.warn(`Not registered — ${registered.reason}`);
      input.output.line('Register the module in bootstrap/app.ts:');
      input.output.line("  import auth from '#modules/auth';");
      input.output.line('  modules: [auth, …]');
    }
    // Its look: a stylesheet of the app, imported by the client entry — in the built index.html, so a server-rendered
    // page is styled before its code loads; classes, never `style` attributes (a strict `style-src` blocks those).
    const styled = importStyles(join(input.root, 'bootstrap', 'client.tsx'));
    if (styled === 'added') input.output.success('Imported its styles (modules/auth/auth.css) in bootstrap/client.tsx');
    else if (styled === 'manual') input.output.line(`Import its styles in the app's client entry: ${AUTH_STYLES_IMPORT}`);

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
    if (!typed) input.output.line('Then: marmeon route:types — it writes the routes and views of the module into bootstrap/routes.ts.');
    input.output.line('Then: marmeon migrate (with NODE_ENV=development — .env.example sets it — it writes the table types) — and set MAIL_* in .env (development writes mails to the log).');
    input.output.line('Its mails go through the queue, on its "mail" queue: a jobs table (marmeon make:queue-table, once) and a worker (marmeon dev starts one; in production: marmeon queue:work, which takes every queue).');
    input.output.line('Expired tokens are pruned at night by the scheduler (marmeon dev starts it; in production: marmeon schedule:work or schedule:run from cron).');
    input.output.line('Accounts whose address was never confirmed stay until your app decides: marmeon auth:prune-unverified deletes them after AUTH_UNVERIFIED_DAYS — its line in modules/auth/schedule.ts is commented out.');
    input.output.line('Registration and the change of address are private: they never tell whether an address has an account (AUTH_PRIVATE_REGISTRATION=false makes them say "taken").');
    input.output.line(`Tests: ${relative(input.root, join(target, 'auth.test.ts'))}`);
    // The lint preset and the devtools belong to the app, not to the module — named when the app has neither yet.
    if (!existsSync(join(input.root, '.oxlintrc.json'))) {
      input.output.line('Lint: marmeon make:lint-config writes the app\'s preset (views import controllers only with import type).');
    }
    if (!('@marmeon/devtools' in installed(input.root))) {
      input.output.line('Devtools for marmeon dev (requests, queries, jobs, mails at /_marmeon/devtools): pnpm add -E -D @marmeon/devtools@<version of your app>');
    }
    // The Content-Security-Policy belongs to the app's middleware too — named when bootstrap/app.ts has none.
    const bootstrap = join(input.root, 'bootstrap', 'app.ts');
    if (existsSync(bootstrap) && !readFileSync(bootstrap, 'utf8').includes('contentSecurityPolicy(')) {
      input.output.line("Content-Security-Policy: add contentSecurityPolicy() of @marmeon/http to the app's global middleware (a nonce per page).");
    }
    return 0;
  }
}

/** The regular files below `directory`, counted without following a link: one to `../..` would walk the whole app. */
function countFiles(directory: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(directory, entry.name));
    else if (entry.isFile() && /\.\w+$/.test(entry.name)) count += 1;
  }
  return count;
}

/**
 * Deletes the files an earlier kit wrote that this one no longer ships, when the app left them unchanged (the hash in
 * `marmeon-stubs.json` still matches); a changed one stays and is named. The manifest is a file of the repository, so a cloned
 * one can name any path: only regular files under `modules/auth/` (never `migrations/`), checked with `escapesRoot` and
 * `lstat` (which never follows a link), and only for the same hash, are removed. The real directory of the file must lie under
 * the module's real directory and outside its migrations, so a link to a directory inside the project reaches nothing else,
 * and a file the kit still ships (by real path, also in another case) is never removed.
 */
function removeLeftovers(root: string, previous: { readonly version: string; readonly files: Readonly<Record<string, { readonly sha256: string }>> } | undefined, copied: readonly string[], output: CommandInput['output']): void {
  if (previous === undefined) return;
  // By real path, so a leftover that only differs in case from a shipped file (a case-insensitive file system) is that file.
  const real = (path: string) => realpathSync.native(path);
  const moduleReal = real(join(root, 'modules', 'auth'));
  const migrationsAt = join(moduleReal, 'migrations');
  const migrationsReal = lstatSync(migrationsAt, { throwIfNoEntry: false }) === undefined ? migrationsAt : real(migrationsAt);
  const shipped = new Set(copied.map((file) => real(join(root, ...file.split('/')))));
  const inside = (base: string, path: string) => path === base || path.startsWith(base + sep);
  for (const [path, entry] of Object.entries(previous.files)) {
    if (!path.startsWith('modules/auth/') || path.startsWith('modules/auth/migrations/')) continue;
    const abs = join(root, ...path.split('/'));
    if (escapesRoot(root, abs) !== undefined) {
      output.warn(`Kept ${path}: it leads out of the project.`);
      continue;
    }
    try {
      const stat = lstatSync(abs, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (!stat.isFile()) {
        output.warn(`Kept ${path}: it is no regular file.`);
        continue;
      }
      // A link on the way (to a directory inside the project) would reach files that are not the module's.
      const parent = real(dirname(abs));
      if (!inside(moduleReal, parent) || inside(migrationsReal, parent)) {
        output.warn(`Kept ${path}: it does not lie in the module's own directories.`);
        continue;
      }
      if (shipped.has(real(abs))) continue;
      if (stubHash(readFileSync(abs)) === entry.sha256) {
        rmSync(abs);
        output.success(`Removed ${path}: the kit of ${previous.version} wrote it, this one no longer ships it, and it was unchanged.`);
      } else {
        output.warn(`Kept ${path}: the kit of ${previous.version} wrote it and this one no longer ships it, but it was changed. Delete it once nothing of yours imports it.`);
      }
    } catch (error) {
      output.warn(`Kept ${path}: ${(error as NodeJS.ErrnoException).code ?? 'it could not be read'}.`);
    }
  }
}

/** The name of a migration without its timestamp and extension, so that the same name under a second timestamp
 * (a new migration to the migrator, which would run again) counts as present — the rule of package-migrations. */
const MIGRATION_FILE = /^\d{4}_\d{2}_\d{2}_\d{6}_([a-z][a-z0-9_]*)\.(?:ts|js|mts|mjs)$/;

/**
 * Writes the migrations of the templates the app lacks and leaves every other file as it is. A migration counts as present when
 * the app has a file of the same name apart from timestamp and extension; `differs` lists the kept files whose content is not the template's.
 */
function copyMigrations(templates: string, target: string): { kept: number; differs: string[]; odd: string[]; raced: string[] } {
  const present = new Map<string, string>();
  for (const file of existsSync(target) ? readdirSync(target) : []) {
    const identity = MIGRATION_FILE.exec(file)?.[1];
    if (identity !== undefined) present.set(identity, file);
  }
  mkdirSync(target, { recursive: true });
  let kept = 0;
  const differs: string[] = [];
  const odd: string[] = [];
  const raced: string[] = [];
  for (const file of readdirSync(templates).sort()) {
    const identity = MIGRATION_FILE.exec(file)?.[1];
    const bytes = readFileSync(join(templates, file));
    const existing = identity === undefined ? undefined : present.get(identity);
    if (existing === undefined) {
      try {
        writeFileSync(join(target, file), bytes, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        raced.push(file);
      }
      continue;
    }
    kept++;
    // A link or a directory is never read: it stands for the migration, and the app looks at it.
    if (!lstatSync(join(target, existing)).isFile()) odd.push(existing);
    else if (stubHash(readFileSync(join(target, existing))) !== stubHash(bytes)) differs.push(existing);
  }
  return { kept, differs, odd, raced };
}

/** The client entry's import of the module's stylesheet. */
export const AUTH_STYLES_IMPORT = "import '../modules/auth/auth.css';";

/** Adds the import of `modules/auth/auth.css` after the client entry's last import — or says it cannot. */
function importStyles(file: string): 'added' | 'present' | 'manual' {
  if (!existsSync(file)) return 'manual';
  const source = readFileSync(file, 'utf8');
  if (source.includes('modules/auth/auth.css')) return 'present';
  const lastImport = [...source.matchAll(/^import .*;.*$/gm)].at(-1);
  if (!lastImport) return 'manual';
  const at = lastImport.index + lastImport[0].length;
  writeFileSync(file, `${source.slice(0, at)}\n${AUTH_STYLES_IMPORT} // the auth module's look (make:auth)${source.slice(at)}`);
  return 'added';
}

/** Adds `auth` to the front of `modules` of the application definition — or says why it cannot. */
function register(file: string): { status: 'added' | 'present' } | { status: 'manual'; reason?: string } {
  if (!existsSync(file)) return { status: 'manual' };
  const edited = editDefinitionFile(file, {
    define: { name: 'defineApplication', from: '@marmeon/core' },
    key: 'modules',
    add: { element: (names) => names.auth!, position: 'first' },
    imports: [{ name: 'auth', from: '#modules/auth', kind: 'default' }],
  }, 'bootstrap/app.ts');
  if (edited.status !== 'manual') return { status: edited.status };
  // A list the editor cannot read may still be the app's own, with auth imported by hand: that is registered.
  const binding = [...importedBindings(readFileSync(file, 'utf8'), 'bootstrap/app.ts').values()].find(
    (candidate) => candidate.from === '#modules/auth' && candidate.imported === 'default' && !candidate.typeOnly,
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
