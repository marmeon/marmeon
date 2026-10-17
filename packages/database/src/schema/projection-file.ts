import { hash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MigrationSource } from '../migrations/load.ts';
import { projectMigrations, type ProjectedTable, type SchemaProjection } from './projection.ts';

// The projection of all migration files, kept in `.marmeon/schema.json` so a process does not import every migration to learn the
// schema. Like `.marmeon/injections.json` it is never trusted blindly: a file is used only if the SHA-256 of every migration file and
// the version of this package match, and it is computed again — in memory, and written back if the directory allows — when they do not.

/** Where the projection is kept, relative to the app root. Not committed: it is derived from the migrations. */
export const PROJECTION_FILE = '.marmeon/schema.json';

/**
 * The format of {@link PROJECTION_FILE}. Another one is not an error: the file is a cache, the projection is computed again. Every
 * change to what a plan step does to the projection, or to the shape of the file, bumps it: the version of the package does not
 * change between commits of this repository, so only the format invalidates a file written by older code.
 */
export const PROJECTION_FORMAT = 1;

/** A migration file the projection was computed from: its name, module and the SHA-256 of its bytes. */
export interface ProjectionSource {
  readonly name: string;
  readonly module: string;
  readonly sha256: string;
}

export interface ProjectionFile {
  readonly format: number;
  /** The version of `@marmeon/database` that computed it: how a plan changes the projection can differ between versions. */
  readonly database: string;
  readonly migrations: readonly ProjectionSource[];
  readonly tables: Readonly<Record<string, ProjectedTable>>;
}

/** The errors of a directory that is not meant to be written (a read-only image): no failure for `marmeon build`. */
export const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);

const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The name, module and hash of each file, in the order given. */
function sourcesOf(files: readonly MigrationSource[]): ProjectionSource[] {
  return files.map((file) => ({ name: file.name, module: file.module, sha256: hash('sha256', readFileSync(file.path), 'hex') }));
}

const sameSources = (a: readonly ProjectionSource[], b: readonly ProjectionSource[]): boolean =>
  a.length === b.length && a.every((source, i) => source.name === b[i]!.name && source.module === b[i]!.module && source.sha256 === b[i]!.sha256);

const DEFAULTS = new Set(['value', 'now', 'uuidv7']);
const ON_DELETE = new Set(['cascade', 'set null', 'restrict', 'no action']);

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** Whether `value` has the shape of a {@link ProjectedTable} — enough that a reader of the file cannot be made to fail on it. */
function isTable(value: unknown, name: string): value is ProjectedTable {
  if (typeof value !== 'object' || value === null) return false;
  const table = value as Record<string, unknown>;
  const each = (entries: unknown, check: (entry: Record<string, unknown>) => boolean) =>
    Array.isArray(entries) && entries.every((entry) => typeof entry === 'object' && entry !== null && check(entry as Record<string, unknown>));
  const text = (entry: Record<string, unknown>, key: string) => typeof entry[key] === 'string';
  return (
    table.name === name &&
    typeof table.module === 'string' &&
    each(
      table.columns,
      (c) =>
        text(c, 'name') &&
        typeof c.type === 'object' &&
        c.type !== null &&
        typeof (c.type as Record<string, unknown>).sqlite === 'string' &&
        typeof (c.type as Record<string, unknown>).pgsql === 'string' &&
        typeof c.nullable === 'boolean' &&
        typeof c.primary === 'boolean' &&
        typeof c.identity === 'boolean' &&
        typeof c.secret === 'boolean' &&
        (c.default === null || DEFAULTS.has(c.default as string)),
    ) &&
    Array.isArray(table.uniques) &&
    table.uniques.every(isStrings) &&
    each(table.indexes, (i) => text(i, 'name') && isStrings(i.columns) && typeof i.unique === 'boolean') &&
    each(
      table.foreignKeys,
      (k) =>
        text(k, 'column') &&
        text(k, 'references') &&
        text(k, 'referenced') &&
        (k.onDelete === undefined || ON_DELETE.has(k.onDelete as string)) &&
        (k.inverse === undefined || typeof k.inverse === 'string'),
    ) &&
    Array.isArray(table.markers) &&
    table.markers.every((m) => m === 'timestamps' || m === 'soft_deletes')
  );
}

/** The document of a file's text; `undefined` for text that is not one of this format. Says nothing of whether it is current. */
export function parseProjectionFile(text: string): ProjectionFile | undefined {
  let parsed: Partial<ProjectionFile> | null;
  try {
    parsed = JSON.parse(text) as Partial<ProjectionFile> | null;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.format !== PROJECTION_FORMAT || typeof parsed.database !== 'string') return undefined;
  const { migrations, tables } = parsed;
  if (!Array.isArray(migrations) || typeof tables !== 'object' || tables === null) return undefined;
  const sources = migrations.every((m) => typeof m === 'object' && m !== null && typeof m.name === 'string' && typeof m.module === 'string' && typeof m.sha256 === 'string');
  if (!sources || !Object.entries(tables).every(([name, table]) => isTable(table, name))) return undefined;
  return parsed as ProjectionFile;
}

/** The text of the file for `projection`, computed from files with these `sources`. Stable, so an unchanged projection rewrites nothing. */
function serialize(projection: SchemaProjection, sources: readonly ProjectionSource[]): string {
  const file: ProjectionFile = { format: PROJECTION_FORMAT, database: version, migrations: sources, tables: Object.fromEntries(projection.tables) };
  return `${JSON.stringify(file, null, 1)}\n`;
}

/**
 * Writes {@link PROJECTION_FILE} for `projection`, which was computed from `files` (atomically: a temporary file renamed into place;
 * nothing is written when the file has that content already). Throws when the directory cannot be written.
 */
export function writeProjection(root: string, projection: SchemaProjection, files: readonly MigrationSource[]): void {
  write(root, serialize(projection, sourcesOf(files)));
}

function write(root: string, text: string): void {
  const path = join(root, PROJECTION_FILE);
  try {
    if (readFileSync(path, 'utf8') === text) return;
  } catch {
    // Not there yet, or unreadable: written below.
  }
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The projection in {@link PROJECTION_FILE} when it was computed from exactly these `files` by this version; otherwise `undefined`. */
export function readProjection(root: string, files: readonly MigrationSource[]): SchemaProjection | undefined {
  return fromFile(root, sourcesOf(files));
}

function fromFile(root: string, sources: readonly ProjectionSource[]): SchemaProjection | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, PROJECTION_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const file = parseProjectionFile(text);
  if (!file || file.database !== version || !sameSources(file.migrations, sources)) return undefined;
  return { migrations: file.migrations.map(({ name, module }) => ({ name, module })), tables: new Map(Object.entries(file.tables)) };
}

export interface LoadProjectionOptions {
  /** How the projection is computed when the file cannot be used. Default: {@link projectMigrations}. */
  readonly project?: (files: readonly MigrationSource[]) => Promise<SchemaProjection>;
  /**
   * Called with the error when the file cannot be written (a read-only directory); the projection is kept in memory then. Default: one
   * warning per process.
   */
  readonly onUnwritable?: (error: NodeJS.ErrnoException) => void;
}

/** The projections of this process by app and content of its migrations, so a second ask reads no file but the migrations' own. */
const loaded = new Map<string, Promise<SchemaProjection>>();
let warned = false;

/** Forgets what this process holds in memory. For tests. @internal */
export function forgetProjections(): void {
  loaded.clear();
  warned = false;
}

/**
 * The projection of all `files`: from {@link PROJECTION_FILE} when it fits them, otherwise computed from their plans and written back
 * (without a writable directory, kept in memory with one warning for the process). Same files, same answer: a process asks the disk once.
 */
export function loadProjection(root: string, files: readonly MigrationSource[], options: LoadProjectionOptions = {}): Promise<SchemaProjection> {
  const sources = sourcesOf(files);
  const key = `${root}\0${version}\0${JSON.stringify(sources)}`;
  let projection = loaded.get(key);
  if (!projection) {
    projection = compute(root, files, sources, options);
    loaded.set(key, projection);
    // A failure is not remembered: a fixed migration is asked again.
    projection.catch(() => loaded.delete(key));
  }
  return projection;
}

async function compute(root: string, files: readonly MigrationSource[], sources: readonly ProjectionSource[], options: LoadProjectionOptions): Promise<SchemaProjection> {
  const fromDisk = fromFile(root, sources);
  if (fromDisk) return fromDisk;
  const projection = await (options.project ?? ((all) => projectMigrations(all)))(files);
  // Any failure to write (a full disk, a read-only directory, a file where the directory should be) leaves the projection in memory: it is a cache.
  try {
    write(root, serialize(projection, sources));
  } catch (error) {
    if (options.onUnwritable) options.onUnwritable(error as NodeJS.ErrnoException);
    else if (!warned) {
      warned = true;
      process.emitWarning(`Marmeon could not write ${PROJECTION_FILE} (${(error as Error).message}); the schema of the migrations is computed in memory, once per process. marmeon build writes it.`);
    }
  }
  return projection;
}
