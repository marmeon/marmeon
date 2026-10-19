import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { err, ok, type Result } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { SET, stubMark } from './upgrades.ts';

/** One migration a package ships: `name` is the file name without `.ts`, `set` and `revision` come from its `// @marmeon-stub` line. */
export interface PackageMigrationFile {
  readonly name: string;
  readonly contents: string;
  readonly set: string;
  readonly revision: number;
}

/** What `"marmeon": { "migrations": … }` of a package declares, read and checked. */
export interface PackageMigrations {
  /** The module the package proposes for its tables; an app can name another. */
  readonly module: string;
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
export const PACKAGE_MIGRATIONS_FORMAT = 1;

const KEYS = new Set(['format', 'module', 'files']);
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/;
const FILE_NAME = /^[a-z][a-z0-9_]*\.ts$/;
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
export const PACKAGE_MIGRATIONS_READERS = new Map<number, (pkg: PackageToRead, field: Record<string, unknown>) => Outcome>([[1, readV1]]);

/**
 * Reads the migrations a package declares under `"marmeon": { "migrations": { "format": 1, "module": "<kebab>", "files": [...] } }`.
 * The field comes from a package the app did not write, so it is read strictly: unknown keys, a newer format, a module name that
 * is no plain kebab-case identifier, and paths that leave the package (absolute, `..`, `\`, a symlink to outside) are refused.
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
  return invalid(pkg, `format ${format} is no longer read; it needs format: ${PACKAGE_MIGRATIONS_FORMAT}.`);
}

function readV1(pkg: PackageToRead, field: Record<string, unknown>): Outcome {
  for (const key of Object.keys(field)) if (!KEYS.has(key)) return invalid(pkg, `unknown key ${show(key)} (known: format, module, files).`);

  const module = field.module;
  if (typeof module !== 'string' || module.length > MAX_MODULE || !KEBAB.test(module) || DEVICE_NAME.test(module)) {
    return invalid(pkg, 'it needs "module", a kebab-case name of at most 64 characters such as "permissions" (the module the tables go to).');
  }
  const paths = field.files;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === 'string')) {
    return invalid(pkg, '"files" must be a non-empty array of paths.');
  }
  if (paths.length > MAX_FILES) return invalid(pkg, `"files" lists more than ${MAX_FILES} files.`);

  let root: string;
  try {
    root = realpathSync(pkg.dir);
  } catch {
    return invalid(pkg, 'the package directory cannot be read.');
  }

  const files: PackageMigrationFile[] = [];
  const names = new Set<string>();
  for (const path of paths as string[]) {
    const segments = path.split('/');
    if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.includes('\0')) {
      return invalid(pkg, `${show(path)} must be a relative path with forward slashes.`);
    }
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return invalid(pkg, `${show(path)} must not contain "..", "." or empty segments.`);
    }
    const base = basename(path);
    if (!FILE_NAME.test(base)) return invalid(pkg, `${show(base)} must be a plain migration name such as create_things_table.ts (no timestamp).`);
    const name = base.slice(0, -'.ts'.length);
    if (names.has(name)) return invalid(pkg, `${show(name)} is listed twice.`);
    names.add(name);

    let real: string;
    try {
      real = realpathSync(join(root, path));
    } catch {
      return invalid(pkg, `${show(path)} does not exist in the package.`);
    }
    // `realpath` follows symlinks, not hard links: a hard link inside the package to a file outside it passes.
    const inside = relative(root, real);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return invalid(pkg, `${show(path)} leads out of the package.`);

    let contents: string;
    try {
      const stat = statSync(real);
      if (!stat.isFile()) return invalid(pkg, `${show(path)} is no file.`);
      if (stat.size > MAX_BYTES) return invalid(pkg, `${show(path)} is larger than ${MAX_BYTES} bytes.`);
      contents = readFileSync(real, 'utf8');
    } catch {
      return invalid(pkg, `${show(path)} cannot be read.`);
    }
    const mark = stubMark(contents);
    if (!mark) return invalid(pkg, `${show(path)} must start with "// @marmeon-stub <set> <revision>".`);
    if (!SET.test(mark.set) || !Number.isSafeInteger(mark.revision) || mark.revision < 1) {
      return invalid(pkg, `${show(path)} has a malformed stub mark: the set is a lowercase name like "queue", the revision a whole number from 1.`);
    }
    files.push({ name, contents, set: mark.set, revision: mark.revision });
  }
  return ok({ module, files });
}
