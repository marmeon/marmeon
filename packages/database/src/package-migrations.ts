import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { err, ok, type Result, type ServiceProviderClass } from '@marmeon/core';
import { belongsTo, isInside, printable, resolveExports, runtimeConditions, withCode } from '@marmeon/core/internal';

/** One migration a package ships: `name` is the file name without its timestamp and `.ts`, `file` its POSIX path in the package. */
export interface PackageMigrationFile {
  readonly name: string;
  readonly file: string;
  readonly contents: string;
}

/** What a service provider declares in `static migrations`: the directory of its package's migrations and the module they go to. */
export interface ProviderMigrations {
  /** The directory in the package, as a `file:` URL: `new URL('../stubs/migrations', import.meta.url)`. */
  readonly from: URL;
  /** The module the package proposes for its tables, kebab-case, such as `permissions`; an app can name another with `--module`. */
  readonly module: string;
}

/** The migrations a package declares, read and checked; `files` are sorted by file name. */
export interface PackageMigrations {
  /** The module the package proposes for its tables; an app can name another. */
  readonly module: string;
  /** The directory of the package that holds the migrations. */
  readonly from: string;
  readonly files: readonly PackageMigrationFile[];
}

/** A package's declaration that cannot be used; `message` starts with the code D21. */
export interface PackageMigrationsError {
  readonly kind: 'invalid-package-migrations';
  readonly message: string;
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/;
const FILE_NAME = /^(\d{4}_\d{2}_\d{2}_\d{6})_([a-z][a-z0-9_]*)\.ts$/;
const MAX_MODULE = 64;
/** @internal */
export const MAX_FILES = 100;
/** @internal */
export const MAX_BYTES = 1 << 20;

function invalid(pkg: { name: string }, why: string): Result<never, PackageMigrationsError> {
  return err({ kind: 'invalid-package-migrations', message: withCode('D21', `${pkg.name} declares the migrations it ships wrongly: ${why}`) });
}

/** A string from a foreign package for a message: quoted, cut at 200 characters, control, format and separator characters escaped. @internal */
export function show(value: string): string {
  return printable(JSON.stringify(value.slice(0, 200)));
}

/**
 * The migrations in `directory`, the real path of a directory inside the package, sorted by file name; `from` is its POSIX path in
 * the package, for messages and `file`. Entries are checked one by one by their real path:
 * a symlink that leads out of the package, a sub-directory or a file that is no regular file never gets read. Files that do not
 * end in `.ts` and sub-directories are passed over; a `.ts` file must be named `<timestamp>_<name>.ts`.
 */
export function readMigrationDirectory(pkg: { name: string; dir: string }, directory: string, from: string): Result<readonly PackageMigrationFile[], PackageMigrationsError> {
  const fail = (why: string) => invalid(pkg, why);
  let root: string;
  try {
    root = realpathSync(pkg.dir);
  } catch {
    return fail('the package directory cannot be read.');
  }

  let entries: string[];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return fail(`${show(from)} cannot be read.`);
  }
  if (entries.length > MAX_FILES) return fail(`${show(from)} holds more than ${MAX_FILES} migrations.`);

  const files: PackageMigrationFile[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    const match = FILE_NAME.exec(entry);
    if (!match) {
      return fail(`${show(entry)} must be named like a migration: <timestamp>_<name>.ts, such as 2026_01_01_000000_create_things_table.ts.`);
    }
    const name = match[2]!;
    if (names.has(name)) return fail(`${show(name)} is in the directory twice, under two timestamps.`);
    names.add(name);

    const path = `${from}/${entry}`;
    let real: string;
    try {
      real = realpathSync(join(directory, entry));
    } catch {
      return fail(`${show(path)} cannot be read.`);
    }
    // `realpath` follows symlinks, not hard links: a hard link inside the package to a file outside it passes.
    if (!isInside(root, real)) return fail(`${show(path)} leads out of the package.`);

    const read = readRegularFile(real, root);
    if (!read.ok) {
      if (read.why === 'not-a-file') return fail(`${show(path)} is no file.`);
      if (read.why === 'too-large') return fail(`${show(path)} is larger than ${MAX_BYTES} bytes.`);
      if (read.why === 'not-utf8') return fail(`${show(path)} is not valid UTF-8.`);
      if (read.why === 'no-migration') return fail(`${show(path)} is no migration: it has no default export.`);
      return fail(`${show(path)} cannot be read.`);
    }
    const contents = read.contents;
    files.push({ name, file: path, contents });
  }
  if (files.length === 0) return fail(`${show(from)} holds no migration.`);
  return ok(files);
}

/**
 * One `static migrations` as read from a provider: parsed once, or why it cannot be. `keys` and `module` are checked only for
 * the package the declaration is assigned to; `value` only stands for the identity of the object and is never read again.
 * `classes` are the provider classes that carry it (the same object on a subclass, or the same directory and module twice).
 * @internal
 */
export type MigrationDeclaration =
  | {
      readonly provider: string;
      readonly ok: true;
      readonly value: object;
      readonly path: string;
      readonly keys: readonly string[];
      readonly module: unknown;
      readonly classes: ServiceProviderClass[];
    }
  | { readonly provider: string; readonly ok: false; readonly message: string; readonly classes: ServiceProviderClass[] };

type Parsed = Extract<MigrationDeclaration, { ok: true }>;

function wrongly(Provider: ServiceProviderClass, provider: string, why: string): MigrationDeclaration {
  return { provider, ok: false, message: withCode('D21', `${provider} declares the migrations of its package wrongly: ${why}`), classes: [Provider] };
}

/**
 * The `static migrations` of `providers`, each read once; the same object twice (a subclass inherits it), or the same directory and
 * module twice, counts once. The static comes from code the app did not write: every property is read a single time and the URL is
 * copied, so a getter or a proxy cannot show another value after the check.
 * @internal
 */
export function migrationDeclarations(providers: readonly ServiceProviderClass[]): MigrationDeclaration[] {
  const byValue = new Map<object, Parsed>();
  const byPath = new Map<string, Parsed>();
  const declarations: MigrationDeclaration[] = [];
  for (const Provider of providers) {
    let provider: string;
    try {
      provider = show(String(Provider.name));
    } catch {
      provider = '"(unnamed provider)"';
    }
    try {
      const value: unknown = (Provider as { migrations?: unknown }).migrations;
      if (value === undefined) continue;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        declarations.push(wrongly(Provider, provider, 'static migrations must be an object: { from: new URL(…), module: "…" }.'));
        continue;
      }
      const same = byValue.get(value);
      if (same) {
        same.classes.push(Provider);
        continue;
      }
      const keys = Object.keys(value);
      const { from, module } = value as { from?: unknown; module?: unknown };
      if (!(from instanceof URL)) {
        declarations.push(wrongly(Provider, provider, "from must be a file: URL, such as new URL('../stubs/migrations', import.meta.url)."));
        continue;
      }
      const url = new URL(String(from.href));
      if (url.protocol !== 'file:' || url.host !== '' || url.search !== '' || url.hash !== '') {
        declarations.push(wrongly(Provider, provider, 'from must be a file: URL without a host, a query or a fragment.'));
        continue;
      }
      const path = resolve(fileURLToPath(url));
      // Only a plain string module is compared: a foreign object is never asked for its text, and a declaration with other keys is another one.
      const key = typeof module === 'string' ? JSON.stringify([module, [...keys].sort(), path]) : undefined;
      const twin = key === undefined ? undefined : byPath.get(key);
      if (twin) {
        twin.classes.push(Provider);
        byValue.set(value, twin);
        continue;
      }
      const declaration: Parsed = { provider, ok: true, value, path, keys, module, classes: [Provider] };
      byValue.set(value, declaration);
      if (key !== undefined) byPath.set(key, declaration);
      declarations.push(declaration);
    } catch {
      declarations.push(wrongly(Provider, provider, 'static migrations cannot be read.'));
    }
  }
  return declarations;
}

/** The D21 messages of declarations that cannot be parsed at all (no object, no `file:` URL, …). @internal */
export function unattributedDeclarations(declarations: readonly MigrationDeclaration[]): string[] {
  return declarations.flatMap((declaration) => (declaration.ok ? [] : [declaration.message]));
}

/** A package as the reader needs it: where it lies, and the `package.json` fields that name its entry. */
export interface ProviderPackage {
  readonly name: string;
  readonly dir: string;
  readonly json: { readonly main?: string; readonly exports?: unknown; readonly marmeon?: unknown };
}

/**
 * The classes a package exports at its main entry, or why they are unknown. The entry is imported only when it lies in the package (no
 * `..` or `node_modules` segment, and its real path inside the real directory): a package cannot make the reader run another one's code.
 * The callers ask only for a package a declaration points into, or one that lists providers, whose entry the app's boot loads anyway.
 * @internal
 */
export async function exportedClasses(pkg: ProviderPackage, root: string): Promise<{ classes: Set<unknown> } | { reason: string }> {
  let entry: string | undefined;
  try {
    entry = resolveExports(pkg, '.', runtimeConditions());
  } catch {
    // a foreign package.json can nest `exports` deep enough to overflow the resolver, or hold a `main` that is no string
    return { reason: 'its package.json names no usable entry' };
  }
  if (entry === undefined) return { reason: 'the package has no entry' };
  let inside = false;
  try {
    inside = belongsTo(resolve(pkg.dir), resolve(entry)) && isInside(root, realpathSync(entry));
  } catch {
    // an entry that does not exist is not in the package
  }
  if (!inside) return { reason: 'its entry leads out of the package' };
  try {
    // The URL the discovery imports, so the classes are the ones the app booted.
    const exported = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    return { classes: new Set(Object.values(exported).filter((candidate) => typeof candidate === 'function')) };
  } catch {
    return { reason: 'its entry could not be imported' };
  }
}

/** Whether the app's boot loads the main entry of the package for its providers: `marmeon.providers` lists some. @internal */
export function discoverable(pkg: ProviderPackage): boolean {
  const field = pkg.json.marmeon;
  const providers = typeof field === 'object' && field !== null ? (field as { providers?: unknown }).providers : undefined;
  return Array.isArray(providers) && providers.length > 0;
}

/** `path` for a message: relative to the package when it lies in it, so a long install path does not cut the useful part. @internal */
export function shown(pkg: { dir: string }, root: string, path: string): string {
  for (const base of [resolve(pkg.dir), root]) {
    const inside = relative(base, path);
    if (!(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) && inside !== '') return show(inside.split(sep).join('/'));
  }
  return show(path);
}

/**
 * Gives each valid declaration to one package: the one with the longest real directory that holds the declaration's directory, by
 * where it really lies and not by the provider that carries the static. It counts for that package only when one of the classes
 * carrying it is exported by the package's main entry: another package's provider cannot claim the directory
 * of a package by naming its path. A provider re-exported from another package carries that package's declaration.
 *
 * Per package: no declaration is `undefined`; two are D21; a directory that leaves the package and every entry that
 * {@link readMigrationDirectory} refuses are D21. `unclaimed` are warnings (they never change a result) for declarations whose directory
 * lies in a package that does not claim them, with the reason; `unattributed` are the messages of declarations that cannot be read and that no package exports. `passedOver` are the providers of valid declarations that lie in none of
 * `packages` (the app's own providers, transitive packages): nothing is said about them.
 * @internal
 */
export async function assignMigrations(
  packages: readonly ProviderPackage[],
  declarations: readonly MigrationDeclaration[],
): Promise<{ results: Map<ProviderPackage, Result<PackageMigrations | undefined, PackageMigrationsError>>; unclaimed: string[]; unattributed: string[]; passedOver: string[] }> {
  const results = new Map<ProviderPackage, Result<PackageMigrations | undefined, PackageMigrationsError>>();
  const roots = new Map<ProviderPackage, string>();
  for (const pkg of packages) {
    try {
      roots.set(pkg, realpathSync(pkg.dir));
    } catch {
      results.set(pkg, invalid(pkg, 'the package directory cannot be read.'));
    }
  }

  const located = new Map<ProviderPackage, Parsed[]>();
  const unclaimed: string[] = [];
  const passedOver: string[] = [];
  const unattributed: string[] = [];
  for (const declaration of declarations) {
    if (!declaration.ok) continue;
    let real: string | undefined;
    try {
      real = realpathSync(declaration.path);
    } catch {
      // checked below, for the package whose path it is
    }
    let best: ProviderPackage | undefined;
    for (const [pkg, root] of roots) {
      const here = belongsTo(root, declaration.path) || belongsTo(resolve(pkg.dir), declaration.path) || (real !== undefined && belongsTo(root, real));
      if (here && (best === undefined || root.length > roots.get(best)!.length)) best = pkg;
    }
    if (best === undefined) passedOver.push(declaration.provider);
    else located.set(best, [...(located.get(best) ?? []), declaration]);
  }

  const unreadable = declarations.filter((declaration) => !declaration.ok);
  const placed = new Set<MigrationDeclaration>();
  for (const [pkg, root] of roots) {
    // One package that cannot be read does not stop the others.
    try {
      const here = located.get(pkg) ?? [];
      const exported = here.length > 0 || (unreadable.length > 0 && discoverable(pkg)) ? await exportedClasses(pkg, root) : undefined;
      const exports = (declaration: MigrationDeclaration) => exported !== undefined && 'classes' in exported && declaration.classes.some((Provider) => exported.classes.has(Provider));
      const mine = here.filter((declaration) => {
        if (exports(declaration)) return true;
        const reason = exported && 'reason' in exported ? exported.reason : 'the package does not export that provider at its main entry';
        unclaimed.push(`${declaration.provider} declares migrations in ${shown(pkg, root, declaration.path)} of ${pkg.name}, which does not claim them: ${reason}.`);
        return false;
      });
      // A declaration that cannot be read has no directory to place it by: the package that exports the provider owns it.
      const broken = unreadable.filter((declaration) => exports(declaration));
      for (const declaration of broken) placed.add(declaration);
      if (broken.length > 0) results.set(pkg, err({ kind: 'invalid-package-migrations', message: (broken[0] as { message: string }).message }));
      else results.set(pkg, readDeclaration(pkg, root, mine));
    } catch {
      results.set(pkg, invalid(pkg, 'the package cannot be read.'));
    }
  }
  for (const declaration of unreadable) {
    if (!placed.has(declaration)) unattributed.push((declaration as { message: string }).message);
  }
  return { results, unclaimed, unattributed, passedOver };
}

/**
 * The migrations that belong to `pkg`: {@link assignMigrations} for one package. `undefined` when none does.
 * @internal
 */
export async function readProviderMigrations(pkg: ProviderPackage, declarations: readonly MigrationDeclaration[]): Promise<Result<PackageMigrations | undefined, PackageMigrationsError>> {
  return (await assignMigrations([pkg], declarations)).results.get(pkg)!;
}

function readDeclaration(pkg: ProviderPackage, root: string, mine: readonly Parsed[]): Result<PackageMigrations | undefined, PackageMigrationsError> {
  const fail = (why: string) => invalid(pkg, why);
  if (mine.length === 0) return ok(undefined);
  if (mine.length > 1) {
    return fail(`declared by two service providers: ${mine.map((declaration) => declaration.provider).join(' and ')} — a package declares one directory.`);
  }
  const declaration = mine[0]!;
  const where = shown(pkg, root, declaration.path);

  for (const key of declaration.keys) if (key !== 'module' && key !== 'from') return fail(`unknown key ${show(key)} (known: module, from).`);
  const module = declaration.module;
  if (typeof module !== 'string' || module.length > MAX_MODULE || !KEBAB.test(module) || DEVICE_NAME.test(module)) {
    return fail('it needs "module", a kebab-case name of at most 64 characters such as "permissions" (the module the tables go to).');
  }

  let real: string;
  try {
    real = realpathSync(declaration.path);
  } catch {
    return fail(`${where} does not exist in the package.`);
  }
  if (real === root) return fail(`${where} leads out of the package: it is the package itself.`);
  if (!belongsTo(root, real)) return fail(`${where} leads out of the package.`);
  try {
    if (!statSync(real).isDirectory()) return fail(`${where} is no directory.`);
  } catch {
    return fail(`${where} cannot be read.`);
  }

  const from = relative(root, real).split(sep).join('/');
  const files = readMigrationDirectory(pkg, real, from);
  if (!files.ok) return files;
  return ok({ module, from, files: files.value });
}

/** @internal */
export type FileRead = { ok: true; contents: string } | { ok: false; why: 'not-a-file' | 'too-large' | 'no-migration' | 'not-utf8' | 'unreadable' };

const DEFAULT_EXPORT = /^\s*export\s+default\b/m;

/**
 * Opened without following a symlink and without blocking (a FIFO would hang), then read through the descriptor. The descriptor
 * must be the file `realpath` found (same device and inode): on Linux the descriptor's own path is checked; elsewhere the path is
 * re-resolved, which narrows the window but cannot close it. A hard link inside the package to a file outside it passes both checks, so the contents must
 * look like a migration: valid UTF-8 with a default export. That is plausibility, not a proof; the risk that remains is
 * acceptable because such a link needs code that runs when the package is installed.
 * @internal
 */
export function readRegularFile(real: string, root: string): FileRead {
  try {
    const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { ok: false, why: 'not-a-file' };
      if (stat.size > MAX_BYTES) return { ok: false, why: 'too-large' };
      const path = lstatSync(real);
      if (path.ino !== stat.ino || path.dev !== stat.dev) return { ok: false, why: 'unreadable' };
      if (realpathSync(real) !== real) return { ok: false, why: 'unreadable' };
      if (process.platform === 'linux') {
        let opened: string | undefined;
        try {
          opened = readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          // no /proc: the device and inode comparison stands
        }
        if (opened !== undefined && !isInside(root, opened)) return { ok: false, why: 'unreadable' };
      }
      const buffer = readFileSync(fd);
      if (buffer.length > MAX_BYTES) return { ok: false, why: 'too-large' };
      let contents: string;
      try {
        // ignoreBOM keeps a leading byte order mark, so `contents` is byte for byte the file.
        contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
      } catch {
        return { ok: false, why: 'not-utf8' };
      }
      if (!DEFAULT_EXPORT.test(contents)) return { ok: false, why: 'no-migration' };
      return { ok: true, contents };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, why: 'unreadable' };
  }
}
