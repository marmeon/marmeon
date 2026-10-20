import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { findPackage } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';
import { readPackageMigrations } from '../package-migrations.ts';
import { findMigration, publishMigration, SYSTEM_MODULE } from './publish-migration.ts';

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'];

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

/** The module whose `index.ts` carries the line `publish` writes when it creates a module for `name`. */
function ownedModule(modules: string, name: string): string | undefined {
  if (!existsSync(modules)) return undefined;
  const line = `// The tables of ${name}: \`marmeon publish ${name}\` writes their migrations here.`;
  for (const module of readdirSync(modules)) {
    if (!KEBAB.test(module)) continue;
    try {
      if (readFileSync(join(modules, module, 'index.ts'), 'utf8').split(/\r?\n/).includes(line)) return module;
    } catch {
      // no index.ts: not a module `publish` made
    }
  }
  return undefined;
}

/**
 * Whether the app's specification of a dependency installs it from the registry: a semver range, a dist-tag or `catalog:`.
 * Anything with a `/` or another `:` is an alias, a path, a repository or a tarball; `.tgz` ends a tarball name.
 */
function fromRegistry(spec: unknown): boolean {
  if (typeof spec !== 'string') return false;
  const text = spec.trim();
  if (text.startsWith('catalog:')) return !text.includes('/');
  return !text.includes('/') && !text.includes(':') && !text.endsWith('.tgz');
}

/**
 * Whether the existing module `module` may be opened for `name` without `--module`: `system` for a package of the framework
 * itself — named `@marmeon/…` by its own `package.json` and listed by the app with a registry specification.
 */
function opensSystem(module: string, name: string, pkg: Package, dependencies: Record<string, unknown>): boolean {
  if (module !== SYSTEM_MODULE || !name.startsWith('@marmeon/') || pkg.json.name !== name) return false;
  const spec = dependencies[name];
  return fromRegistry(spec);
}

/**
 * `marmeon publish <package> [--module=<name>]`: copies the migrations a direct dependency of your app lists under
 * `"marmeon": { "migrations": … }` into a module: `--module`; else the module whose `index.ts` says `publish` made it for the
 * package (every file of the package the app has must lie there, or the command refuses); else, refusing when a file of the
 * package lies in another module or the proposed module is the app's, the module the package proposes. The files are the app's
 * afterwards. It writes what is missing and skips what is there, so it can run again; it never touches the database. It only
 * copies files and runs no code of the package (the CLI boots the app as for any command of the app). Then `marmeon migrate`. See `docs/migrations.md#publishing-the-migrations-of-a-package`.
 */
export class PublishCommand {
  static command = 'publish';
  static description = 'Copy the migrations of a package into your app';
  static usage = '<package> [--module=<name>]';
  static options = { module: { type: 'string', short: 'm' } } as const;

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

    const explicit = typeof input.options.module === 'string' ? input.options.module : undefined;
    if (explicit !== undefined && !KEBAB.test(explicit)) {
      output.error('Pass the module as a kebab-case name: --module=<name>.');
      return 1;
    }

    // A migration another direct dependency lists under the same name would create the same table twice.
    for (const dependency of Object.keys(dependencies)) {
      if (dependency === name) continue;
      try {
        const other = locate(dependency, input.root);
        const listed = other ? readPackageMigrations(other) : undefined;
        if (!listed?.ok || !listed.value) continue;
        const names = new Set(listed.value.files.map((file) => file.name));
        const shared = manifest.files.find((file) => names.has(file.name));
        if (shared) {
          output.error(`${name} lists ${shared.name}, the name of a migration ${dependency} lists too — it cannot publish it.`);
          return 1;
        }
      } catch {
        // a package that cannot be read protects nothing
      }
    }

    const modules = join(input.root, 'modules');
    const pending = manifest.files.filter((file) => !findMigration(modules, file.name));

    // The module: --module; else the one `publish` made for this package (its index.ts says so), in which every file of the package
    // that the app has must lie; else the proposal. A module of the app that exists is opened only by --module, by that line, or
    // — `system` — for a package of the framework itself: a package from outside must not put tables into a module of the app,
    // and a file of the package in some module is no reason to.
    const elsewhere = (file: string, where: string) =>
      `${file} of ${name} is in modules/${where}, which publish did not create for ${name} — if you put it there, pass --module=${where}; otherwise ${name} ships a migration with a name your app already uses.`;
    let module = explicit;
    if (module === undefined) {
      const owned = ownedModule(modules, name);
      if (owned !== undefined) {
        for (const file of manifest.files) {
          if (findMigration(modules, file.name, owned) !== undefined) continue;
          const present = findMigration(modules, file.name);
          if (present) {
            output.error(elsewhere(file.name, basename(dirname(dirname(present)))));
            return 1;
          }
        }
        module = owned;
      } else if (pending.length > 0) {
        for (const file of manifest.files) {
          const present = findMigration(modules, file.name);
          const where = present && basename(dirname(dirname(present)));
          if (where !== undefined && !(where === manifest.module && opensSystem(manifest.module, name, pkg, dependencies))) {
            output.error(elsewhere(file.name, where));
            return 1;
          }
        }
        module = manifest.module;
        if (existsSync(join(modules, module)) && !opensSystem(module, name, pkg, dependencies)) {
          output.error(`modules/${module} is your app's — pass --module=<name> to put the tables of ${name} there, or another name.`);
          return 1;
        }
      }
    }
    // `publishMigration` does not check a module it is given.
    if (module !== undefined && !KEBAB.test(module)) {
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
      const code = publishMigration(input, { name: file.name, contents: file.contents, table: file.name, module: module!, at: new Date(start + index * 1000), owner, hint: false });
      if (code !== 0) return code;
      written += 1;
    }
    if (written === 0) {
      output.success(`Nothing to publish — every migration of ${name} is in your app`);
      return 0;
    }

    output.line('Then: marmeon migrate');
    return 0;
  }
}
