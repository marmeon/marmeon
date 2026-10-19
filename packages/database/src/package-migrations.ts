import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { err, ok, type Result } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';

/** One migration a package ships: `name` is the file name without its timestamp and `.ts`, `file` its POSIX path in the package. */
export interface PackageMigrationFile {
  readonly name: string;
  readonly file: string;
  readonly contents: string;
}

/** What `"marmeon": { "migrations": … }` of a package declares, read and checked; `files` are sorted by file name. */
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

/** The package as the reader sees it: its name, its real directory and the parsed `package.json`. */
export interface PackageToRead {
  name: string;
  dir: string;
  json: { marmeon?: { migrations?: unknown } };
}

type Outcome = Result<PackageMigrations | undefined, PackageMigrationsError>;

/** The format this release writes. */
export const PACKAGE_MIGRATIONS_FORMAT = 2;

const KEYS = new Set(['format', 'module', 'from']);
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/;
const FILE_NAME = /^(\d{4}_\d{2}_\d{2}_\d{6})_([a-z][a-z0-9_]*)\.ts$/;
const MAX_MODULE = 64;
const MAX_FILES = 100;
const MAX_BYTES = 1 << 20;

function invalid(pkg: { name: string }, why: string): Result<never, PackageMigrationsError> {
  return err({ kind: 'invalid-package-migrations', message: withCode('D21', `${pkg.name} lists its migrations in package.json wrongly: ${why}`) });
}

/** A string from a foreign package for a message: quoted, cut at 200 characters, control characters (C0 by JSON, C1 here) escaped. */
function show(value: string): string {
  return JSON.stringify(value.slice(0, 200)).replace(/[\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The formats this release reads, each with the function that reads the field of it. Registering a reader is how a later
 * release keeps reading the format before it.
 * @internal
 */
export const PACKAGE_MIGRATIONS_READERS = new Map<number, (pkg: PackageToRead, field: Record<string, unknown>) => Outcome>([[2, readV2]]);

/**
 * Reads the migrations a package declares under `"marmeon": { "migrations": { "format": 2, "module": "<kebab>", "from": "<directory>" } }`.
 * The field comes from a package the app did not write, so it is read strictly: unknown keys, a newer format, a module name that
 * is no plain kebab-case identifier, and a directory that leaves the package (absolute, `..`, `\`, a symlink to outside, for the directory and for each file) are refused.
 * Without the field the result is `undefined`. Nothing is copied here.
 * See `docs/package-development.md#declaring-the-migrations-a-package-ships`.
 */
export function readPackageMigrations(pkg: PackageToRead): Outcome {
  const declared = pkg.json.marmeon?.migrations;
  if (declared === undefined) return ok(undefined);
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return invalid(pkg, '"migrations" must be an object.');
  const field = declared as Record<string, unknown>;

  const { format } = field;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) return invalid(pkg, `it needs format: ${PACKAGE_MIGRATIONS_FORMAT}.`);
  const reader = PACKAGE_MIGRATIONS_READERS.get(format);
  if (reader) return reader(pkg, field);
  if (format > Math.max(...PACKAGE_MIGRATIONS_READERS.keys())) return invalid(pkg, `format ${format} was written for a newer Marmeon — update marmeon.`);
  return invalid(pkg, `format ${format} is no longer read: name the directory — { "format": 2, "module": "…", "from": "stubs/migrations" }.`);
}

function readV2(pkg: PackageToRead, field: Record<string, unknown>): Outcome {
  for (const key of Object.keys(field)) if (!KEYS.has(key)) return invalid(pkg, `unknown key ${show(key)} (known: format, module, from).`);

  const module = field.module;
  if (typeof module !== 'string' || module.length > MAX_MODULE || !KEBAB.test(module) || DEVICE_NAME.test(module)) {
    return invalid(pkg, 'it needs "module", a kebab-case name of at most 64 characters such as "permissions" (the module the tables go to).');
  }
  const from = field.from;
  if (typeof from !== 'string') return invalid(pkg, 'it needs "from", the directory of the package that holds the migrations, such as "stubs/migrations".');

  const files = readMigrationDirectory(pkg, from);
  if (!files.ok) return files;
  return ok({ module, from, files: files.value });
}

/** Whether `real` lies inside `root` (both real paths) and is not `root` itself. */
function isInside(root: string, real: string): boolean {
  const inside = relative(root, real);
  return !(inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside));
}

/**
 * The migrations in the directory `from` of a package, sorted by file name. Entries are checked one by one by their real path:
 * a symlink that leads out of the package, a sub-directory or a file that is no regular file never gets read. Files that do not
 * end in `.ts` and sub-directories are passed over; a `.ts` file must be named `<timestamp>_<name>.ts`.
 */
export function readMigrationDirectory(pkg: { name: string; dir: string }, from: string): Result<readonly PackageMigrationFile[], PackageMigrationsError> {
  if (from === '' || from.startsWith('/') || /^[A-Za-z]:/.test(from) || from.includes('\\') || from.includes('\0')) {
    return invalid(pkg, `${show(from)} must be a relative path with forward slashes.`);
  }
  if (from.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return invalid(pkg, `${show(from)} must not contain "..", "." or empty segments.`);
  }

  let root: string;
  let directory: string;
  try {
    root = realpathSync(pkg.dir);
  } catch {
    return invalid(pkg, 'the package directory cannot be read.');
  }
  try {
    directory = realpathSync(join(root, from));
  } catch {
    return invalid(pkg, `${show(from)} does not exist in the package.`);
  }
  if (!isInside(root, directory)) return invalid(pkg, `${show(from)} leads out of the package.`);
  try {
    if (!statSync(directory).isDirectory()) return invalid(pkg, `${show(from)} is no directory.`);
  } catch {
    return invalid(pkg, `${show(from)} cannot be read.`);
  }

  let entries: string[];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return invalid(pkg, `${show(from)} cannot be read.`);
  }
  if (entries.length > MAX_FILES) return invalid(pkg, `${show(from)} holds more than ${MAX_FILES} migrations.`);

  const files: PackageMigrationFile[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    const match = FILE_NAME.exec(entry);
    if (!match) {
      return invalid(pkg, `${show(entry)} must be named like a migration: <timestamp>_<name>.ts, such as 2026_01_01_000000_create_things_table.ts.`);
    }
    const name = match[2]!;
    if (names.has(name)) return invalid(pkg, `${show(name)} is in the directory twice, under two timestamps.`);
    names.add(name);

    const path = `${from}/${entry}`;
    let real: string;
    try {
      real = realpathSync(join(directory, entry));
    } catch {
      return invalid(pkg, `${show(path)} cannot be read.`);
    }
    // `realpath` follows symlinks, not hard links: a hard link inside the package to a file outside it passes.
    if (!isInside(root, real)) return invalid(pkg, `${show(path)} leads out of the package.`);

    const read = readRegularFile(real, root);
    if (!read.ok) {
      if (read.why === 'not-a-file') return invalid(pkg, `${show(path)} is no file.`);
      if (read.why === 'too-large') return invalid(pkg, `${show(path)} is larger than ${MAX_BYTES} bytes.`);
      if (read.why === 'not-utf8') return invalid(pkg, `${show(path)} is not valid UTF-8.`);
      if (read.why === 'no-migration') return invalid(pkg, `${show(path)} is no migration: it has no default export.`);
      return invalid(pkg, `${show(path)} cannot be read.`);
    }
    const contents = read.contents;
    files.push({ name, file: path, contents });
  }
  if (files.length === 0) return invalid(pkg, `${show(from)} holds no migration.`);
  return ok(files);
}

type FileRead = { ok: true; contents: string } | { ok: false; why: 'not-a-file' | 'too-large' | 'no-migration' | 'not-utf8' | 'unreadable' };

const DEFAULT_EXPORT = /^\s*export\s+default\b/m;

/**
 * Opened without following a symlink and without blocking (a FIFO would hang), then read through the descriptor. The descriptor
 * must be the file `realpath` found (same device and inode): on Linux the descriptor's own path is checked; elsewhere the path is
 * re-resolved, which narrows the window but cannot close it. A hard link inside the package to a file outside it passes both checks, so the contents must
 * look like a migration: valid UTF-8 with a default export. That is plausibility, not a proof; the risk that remains is
 * acceptable because such a link needs code that runs when the package is installed.
 */
function readRegularFile(real: string, root: string): FileRead {
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
