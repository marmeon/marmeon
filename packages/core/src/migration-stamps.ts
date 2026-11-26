import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The file name the migrator reads: `2026_10_02_213000_create_cache_table.ts`. */
const MIGRATION_FILE = /^(\d{4}_\d{2}_\d{2}_\d{6})_[a-z0-9_]+\.(?:ts|js|mts|mjs)$/;

/** The newest migration of the modules and where it lies. */
export interface NewestMigration {
  /** `2026_10_02_213000`. */
  readonly stamp: string;
  readonly path: string;
}

/** `2026_10_02_213000` — the order migrations run in. */
export function migrationTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}_${pad(date.getUTCMonth() + 1)}_${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/**
 * The migration with the greatest timestamp among the `migrations` folders of the modules under `modules` (file names only; the
 * first by module name and file name when two share one); undefined when there is none. Reads names, imports nothing.
 * @internal
 */
export function newestMigration(modulesDir: string): NewestMigration | undefined {
  if (!existsSync(modulesDir)) return undefined;
  let newest: NewestMigration | undefined;
  for (const module of readdirSync(modulesDir).sort()) {
    const directory = join(modulesDir, module, 'migrations');
    // A `migrations` entry that is no folder (a file, a link to nothing) holds no migration.
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const file of readdirSync(directory).sort()) {
      const match = MIGRATION_FILE.exec(file);
      if (match && (newest === undefined || match[1]! > newest.stamp)) newest = { stamp: match[1]!, path: join(directory, file) };
    }
  }
  return newest;
}

/**
 * The timestamps for `count` new files (`subject` in the messages), a second apart, from now on and behind `newest`; or why that
 * cannot be: a newest stamp in the future that is no date, or that leaves no room. A newest stamp in the past is never a reason.
 * @internal
 */
export function stampsBehind(
  newest: NewestMigration | undefined,
  count: number,
  root: string,
  subject = 'a copy',
  clock: number = Date.now(),
): { stamps: Date[] } | { error: string } {
  const now = Math.floor(clock / 1000) * 1000;
  let start = now;
  if (newest !== undefined && newest.stamp >= migrationTimestamp(new Date(now))) {
    const match = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(newest.stamp);
    const [year, month, day, hour, minute, second] = (match?.slice(1) ?? []).map(Number) as number[];
    if (!match || month! < 1 || month! > 12 || day! < 1 || day! > 31 || hour! > 23 || minute! > 59 || second! > 59) {
      return { error: `${relative(root, newest.path)} has a timestamp that is no date, so ${subject} cannot be put behind it — rename it with a valid one.` };
    }
    start = Date.UTC(year!, month! - 1, day!, hour, minute, second) + 1000;
  }
  const dates = Array.from({ length: count }, (_, index) => new Date(start + index * 1000));
  for (const date of dates) {
    // Start is now (newer than newest) or newest + 1 s, so every stamp is behind newest; only a year past 9999 leaves no room.
    const stamp = migrationTimestamp(date);
    if (!/^\d{4}_/.test(stamp)) {
      return { error: `${relative(root, newest!.path)} has a timestamp that leaves no room behind it — rename it with an earlier one.` };
    }
  }
  return { stamps: dates };
}

/**
 * The timestamp (`2026_10_02_213000`) for the next migration of the app at `root`: the later of now and one second after the newest
 * migration of every module, read from the file names in each module's `migrations` folder under `modules`, as `marmeon publish` reads them.
 * It throws, naming the file, when the newest stamp lies in the future and is no date or leaves no room behind it; a past stamp never refuses.
 * A `migrations` folder that exists but cannot be read throws its filesystem error; an entry that is no folder is skipped.
 * See `docs/package-development.md#registering-what-a-generator-writes`.
 */
export function nextMigrationStamp(root: string): string {
  const next = stampsBehind(newestMigration(join(root, 'modules')), 1, root, 'a new migration');
  if ('error' in next) throw new Error(next.error);
  return migrationTimestamp(next.stamps[0]!);
}
