import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application, type ServiceProviderClass } from '@marmeon/core';
import { findPackage, resolveExports, runtimeConditions } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';
import { readPackageMigrations } from '../package-migrations.ts';
import { stubMark } from '../upgrades.ts';
import { missingUpgrades } from './make-upgrade-migrations.ts';
import { findMigration, publishMigration, SYSTEM_MODULE } from './publish-migration.ts';

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'];
const TIMESTAMP = /^\d{4}_\d{2}_\d{2}_\d{6}_/;

type Package = NonNullable<ReturnType<typeof findPackage>>;

/**
 * The installed package `name` of the app: in `node_modules` of the app, or of a directory above it up to the first one with a
 * lockfile (a workspace root, where the package manager hoists). Never further — a `node_modules` next to the home directory is
 * not the app's.
 */
function locate(name: string, root: string): Package | undefined {
  const hasLockfile = (dir: string) => LOCKFILES.some((lockfile) => existsSync(join(dir, lockfile)));
  const directories: string[] = [];
  for (let dir = root; ; dir = dirname(dir)) {
    directories.push(dir);
    if (hasLockfile(dir)) break;
    if (dirname(dir) === dir) {
      // no lockfile anywhere above: the app stands alone
      directories.length = 1;
      break;
    }
  }
  for (const dir of directories) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return findPackage(name, dir);
  }
  return undefined;
}

/** The provider classes a package exports under the names it lists in `marmeon.providers` — the classes it brings itself. */
async function providersOf(pkg: Package): Promise<Set<unknown>> {
  const own = new Set<unknown>();
  const listed = pkg.json.marmeon?.providers;
  if (!Array.isArray(listed)) return own;
  try {
    const entry = resolveExports(pkg, '.', runtimeConditions());
    if (!entry) return own;
    const exports = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    for (const name of listed) if (typeof name === 'string' && typeof exports[name] === 'function') own.add(exports[name]);
  } catch {
    // A package that does not load owns nothing.
  }
  return own;
}

/**
 * The sets and migration names the app's providers upgrade or create, each marked with whether the package brings them itself (every provider that names one must be the package's).
 * A package that is not the owner of a set the framework upgrades must not publish into it: the app would stop getting
 * that set's upgrades. Ownership is the class: a provider counts as the package's when it is the very class the package exports
 * under a name in `marmeon.providers` and no other discovered package lists that name.
 */
function known(providers: readonly ServiceProviderClass[], own: ReadonlySet<unknown>, ambiguous: ReadonlySet<string>): { sets: Map<string, boolean>; names: Map<string, boolean> } {
  const sets = new Map<string, boolean>();
  const names = new Map<string, boolean>();
  for (const Provider of providers) {
    const mine = own.has(Provider) && !ambiguous.has(Provider.name);
    for (const upgrade of Provider.migrationUpgrades ?? []) {
      sets.set(upgrade.set, (sets.get(upgrade.set) ?? true) && mine);
      for (const name of [upgrade.name, ...upgrade.createdBy]) names.set(name, (names.get(name) ?? true) && mine);
    }
  }
  return { sets, names };
}

/** The migrations in `modules/*\/migrations` that carry a stub mark: file name without timestamp, set and module. */
function markedMigrations(modules: string): { name: string; set: string; module: string }[] {
  const found: { name: string; set: string; module: string }[] = [];
  if (!existsSync(modules)) return found;
  for (const module of readdirSync(modules)) {
    const directory = join(modules, module, 'migrations');
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory)) {
      if (!TIMESTAMP.test(file) || !file.endsWith('.ts')) continue;
      try {
        const mark = stubMark(readFileSync(join(directory, file), 'utf8'));
        if (mark) found.push({ name: file.replace(TIMESTAMP, '').slice(0, -'.ts'.length), set: mark.set, module });
      } catch {
        // unreadable: not one we can tell
      }
    }
  }
  return found;
}

function markOf(file: string): ReturnType<typeof stubMark> {
  try {
    return stubMark(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * `marmeon publish <package> [--module=<name>]`: copies the migrations a direct dependency of your app lists under
 * `"marmeon": { "migrations": … }` into a module — `--module`, else the module that already holds one of them, else the module
 * the package proposes. The files are the app's afterwards. It writes what is missing and skips what is there, so it can run
 * again; it never touches the database. Then `marmeon migrate`. See `docs/migrations.md#publishing-the-migrations-of-a-package`.
 */
export class PublishCommand {
  static command = 'publish';
  static description = 'Copy the migrations of a package into your app';
  static usage = '<package> [--module=<name>]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(input: CommandInput): Promise<number> {
    const { output } = input;
    const name = input.args[0];
    if (name === undefined || input.args.length > 1) {
      output.error('Pass the package: marmeon publish <package> [--module=<name>]');
      return 1;
    }

    // Only a package the app chose: a transitive one is in node_modules without the app having asked for it.
    let dependencies: Record<string, unknown> = Object.create(null);
    try {
      const json = JSON.parse(readFileSync(join(input.root, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
      dependencies = Object.assign(Object.create(null), json.dependencies, json.devDependencies);
    } catch {
      output.error('The package.json of your app cannot be read.');
      return 1;
    }
    if (!(name in dependencies)) {
      output.error(`${name} is not a dependency of your app — add it first.`);
      return 1;
    }

    let pkg;
    try {
      pkg = locate(name, input.root);
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (!pkg) {
      output.error(`${name} is not installed in your app — install your dependencies first.`);
      return 1;
    }
    const read = readPackageMigrations(pkg);
    if (!read.ok) {
      output.error(read.error.message);
      return 1;
    }
    if (!read.value) {
      output.error(`${name} ships no migrations.`);
      return 1;
    }
    const manifest = read.value;
    const sets = new Set(manifest.files.map((file) => file.set));
    const fileNames = new Set(manifest.files.map((file) => file.name));

    const explicit = typeof input.options.module === 'string' ? input.options.module : undefined;
    if (explicit !== undefined && !KEBAB.test(explicit)) {
      output.error('Pass the module as a kebab-case name: --module=<name>.');
      return 1;
    }

    // The providers another discovered package lists under the same name are not told apart from this package's by name.
    const ambiguous = new Set<string>();
    for (const other of this.#app.packages) {
      if (other === name) continue;
      try {
        const listed = locate(other, input.root)?.json.marmeon?.providers;
        if (Array.isArray(listed)) for (const provider of listed) if (typeof provider === 'string') ambiguous.add(provider);
      } catch {
        // a package.json that cannot be read lists nothing
      }
    }
    const taken = known(this.#app.providers, await providersOf(pkg), ambiguous);

    // The stubs of the other dependencies of the app are as protected as the upgrades of the providers.
    for (const dependency of Object.keys(dependencies)) {
      if (dependency === name) continue;
      try {
        const other = locate(dependency, input.root);
        const listed = other ? readPackageMigrations(other) : undefined;
        if (!listed?.ok || !listed.value) continue;
        for (const file of listed.value.files) {
          taken.sets.set(file.set, false);
          taken.names.set(file.name, false);
        }
      } catch {
        // a package that cannot be read protects nothing
      }
    }

    for (const file of manifest.files) {
      if (taken.sets.get(file.set) === false) {
        output.error(`${name} lists a migration of the "${file.set}" tables, which another package upgrades or creates — it cannot publish them.`);
        return 1;
      }
      if (taken.names.get(file.name) === false) {
        output.error(`${name} lists ${file.name}, the name of a migration another package creates or upgrades — it cannot publish it.`);
        return 1;
      }
    }

    // A set the app already has in a file the package does not list is the app's (or another package's): not the package's to extend.
    const modules = join(input.root, 'modules');
    for (const present of markedMigrations(modules)) {
      if (sets.has(present.set) && !fileNames.has(present.name) && taken.names.get(present.name) !== true) {
        output.error(`modules/${present.module} already has ${present.name}, a migration of the "${present.set}" tables that ${name} does not list — it cannot publish into that set.`);
        return 1;
      }
    }

    // The module: --module; else the one that holds a file of the package already; else the proposal, which must be new unless it is `system`.
    let module = explicit;
    if (module === undefined) {
      for (const file of manifest.files) {
        const present = findMigration(modules, file.name);
        // Only a file marked for the package's own set says the module is the package's: an unmarked one is the app's.
        if (present && markOf(present)?.set === file.set) {
          module = basename(dirname(dirname(present)));
          break;
        }
      }
    }
    if (module === undefined) {
      module = manifest.module;
      if (module !== SYSTEM_MODULE && existsSync(join(modules, module))) {
        output.error(`modules/${module} is your app's — pass --module=<name> to put the tables of ${name} there, or another name.`);
        return 1;
      }
    }
    // `publishMigration` does not check a module it is given.
    if (!KEBAB.test(module)) {
      output.error('Pass the module as a kebab-case name: --module=<name>.');
      return 1;
    }

    const start = Date.now();
    let written = 0;
    for (const [index, file] of manifest.files.entries()) {
      const present = findMigration(modules, file.name);
      if (present) {
        output.line(`${relative(input.root, present)} is there — skipped`);
        continue;
      }
      const owner = module === SYSTEM_MODULE ? undefined : name;
      const code = publishMigration(input, { name: file.name, contents: file.contents, table: file.set, module, at: new Date(start + index * 1000), owner, hint: false });
      if (code !== 0) return code;
      written += 1;
    }
    if (written === 0) {
      output.success(`Nothing to publish — every migration of ${name} is in your app`);
      return 0;
    }

    if (missingUpgrades(input.root, this.#app.providers).missing.some(({ upgrade }) => sets.has(upgrade.set))) output.line('Then: marmeon make:upgrade-migrations');
    output.line('Then: marmeon migrate');
    return 0;
  }
}
