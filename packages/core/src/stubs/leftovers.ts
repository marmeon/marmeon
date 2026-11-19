import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { escapesRoot } from '../paths.ts';
import { stubHash } from './manifest.ts';

/** What `removeLeftovers` says: the lines of a command's output. */
interface LeftoversOutput {
  success(line: string): void;
  warn(line: string): void;
}

const MODULE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Deletes the files an earlier kit wrote that this one no longer ships, when the app left them unchanged (the hash in
 * `marmeon-stubs.json` still matches); a changed one stays and is named. The manifest is a file of the repository, so a cloned
 * one can name any path: only regular files under `modules/<moduleName>/` (never `migrations/`), checked with `escapesRoot` and
 * `lstat` (which never follows a link), and only for the same hash, are removed. The real directory of the file must lie under
 * the module's real directory and outside its migrations, so a link to a directory inside the project reaches nothing else,
 * and a file the kit still ships (by real path, also in another case) is never removed. Used by the generators of the framework's packages. @internal
 */
export function removeLeftovers(root: string, moduleName: string, previous: { readonly version: string; readonly files: Readonly<Record<string, { readonly sha256: string }>> } | undefined, copied: readonly string[], output: LeftoversOutput): void {
  if (!MODULE_NAME.test(moduleName)) throw new TypeError(`removeLeftovers: the module name must be kebab-case, not ${JSON.stringify(moduleName)}.`);
  if (previous === undefined) return;
  // By real path, so a leftover that only differs in case from a shipped file (a case-insensitive file system) is that file.
  const real = (path: string) => realpathSync.native(path);
  const moduleReal = real(join(root, 'modules', moduleName));
  const migrationsAt = join(moduleReal, 'migrations');
  const migrationsReal = lstatSync(migrationsAt, { throwIfNoEntry: false }) === undefined ? migrationsAt : real(migrationsAt);
  const shipped = new Set(copied.map((file) => real(join(root, ...file.split('/')))));
  const inside = (base: string, path: string) => path === base || path.startsWith(base + sep);
  for (const [path, entry] of Object.entries(previous.files)) {
    if (!path.startsWith(`modules/${moduleName}/`) || path.startsWith(`modules/${moduleName}/migrations/`)) continue;
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
