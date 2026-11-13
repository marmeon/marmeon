import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { entryInside } from './contain.ts';
import { DiscoveryError } from './error.ts';
import { resolveExports, type PackageInfo } from './resolve.ts';

/** The user interface a package declares in its `"marmeon"` field, as written: shape checked, nothing resolved yet. */
export interface PackageUiField {
  readonly namespace: string;
  readonly entry?: { readonly client: string; readonly ssr: string };
  readonly views?: string;
  readonly lang?: string;
}

/** What a package's user interface consists of, resolved to files inside the package (docs/package-development.md#pages-of-a-package). */
export interface PackageSurface {
  /** The package's name in the dependency list. */
  readonly package: string;
  readonly namespace: string;
  /** Absolute paths of the client and server entry the `entry` subpaths resolve to. */
  readonly entry?: { readonly client: string; readonly ssr: string };
  /** View name (`entries/Edit`, from the path below the pattern) → real path of its file. Sorted by name. */
  readonly views: Readonly<Record<string, string>>;
  /** Locale (`en`, `de-AT`) → real path of its language file. Sorted by locale. */
  readonly lang: Readonly<Record<string, string>>;
}

/** Namespaces a package cannot take: `app` is the app's own, `marmeon` the framework's. */
export const RESERVED_NAMESPACES: readonly string[] = ['app', 'marmeon'];
/** The shape of a namespace: lowercase letters and digits in words joined by single hyphens, starting with a letter. */
export const NAMESPACE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** The longest namespace a package may declare. */
export const MAX_NAMESPACE_LENGTH = 32;
/** One segment of a view name; segments are joined by `/`. */
export const VIEW_SEGMENT = /^[A-Za-z0-9_-]+$/;
/** The most views one package may list. */
export const MAX_VIEWS = 1000;
/** The most language files one package may list. */
export const MAX_LANG_FILES = 100;
/** A language tag as a file name: `en`, `de-AT`, `zh-Hant-TW`. */
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
/** Deeper than any real view tree: a hostile package ends here. */
const MAX_DEPTH = 16;
/** Files that are no views or texts: tests and declarations. */
const NOT_A_SOURCE = /\.(?:test|spec|type-test)\.|\.d\.[cm]?ts$/;

/** Whether `value` is a namespace a package may take: the right shape, short enough and not reserved. */
export function isNamespace(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_NAMESPACE_LENGTH && NAMESPACE.test(value) && !RESERVED_NAMESPACES.includes(value);
}

/** Whether `name` is a view name: `/`-separated segments of letters, digits, `_` and `-`. */
export function isViewName(name: string): boolean {
  return name.split('/').every((segment) => VIEW_SEGMENT.test(segment));
}

/**
 * The files of the pattern `<subpath>/*` in the package's `exports`: its target must end in `/*<extension>` (`./dist/views/*.js`).
 * Only the directory the pattern leads to is listed — never `node_modules` — and every file must lie in the package, also by its
 * real path. A directory that does not exist yet (an unbuilt package) lists nothing.
 */
function listPattern(
  pkg: PackageInfo,
  subpath: string,
  key: 'views' | 'lang',
  conditions: readonly string[],
  options: { readonly recursive: boolean; readonly max: number },
): Map<string, string> {
  const pattern = `${subpath}/*`;
  const target = resolveExports(pkg, pattern, conditions);
  if (target === undefined) {
    throw new DiscoveryError(`${pkg.name} declares "${key}" in its "marmeon" field, but its "exports" has no entry for that subpath with "/*" (a pattern such as "./views/*") that applies here.`);
  }
  const file = basename(target);
  const extension = file.slice(1);
  if (!file.startsWith('*') || target.indexOf('*') !== target.length - file.length || !/^\.[A-Za-z0-9]+$/.test(extension)) {
    throw new DiscoveryError(`${pkg.name} maps the "exports" pattern of its "${key}" to a target that does not end in "/*" and an extension (such as "./dist/${key}/*.js").`);
  }
  const directory = dirname(target);
  if (!entryInside(pkg.dir, directory)) {
    throw new DiscoveryError(`${pkg.name} maps the "exports" pattern of its "${key}" to a directory outside the package, or to the package root itself: the target must be a folder below the package root.`);
  }

  const found = new Map<string, string>();
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // Not built yet, or not a directory: nothing to list. Anything else (EACCES) is a fact worth stopping for.
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw new DiscoveryError(`${pkg.name} has a "${key}" directory that cannot be read.`);
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name);
      if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'node_modules') continue;
      const link = entry.isSymbolicLink();
      // A link is followed only to a file of the package; a linked directory is not walked, so no loop can arise.
      if (link && !entryInside(pkg.dir, path)) {
        throw new DiscoveryError(`${pkg.name} has a file in its "${key}" that is a link leading out of the package.`);
      }
      const directoryLike = link ? statSync(path, { throwIfNoEntry: false })?.isDirectory() === true : entry.isDirectory();
      if (directoryLike) {
        if (!link && options.recursive) {
          if (depth >= MAX_DEPTH) throw new DiscoveryError(`${pkg.name} has a "${key}" folder nested deeper than ${MAX_DEPTH} levels, the most a package may have.`);
          walk(path, `${prefix}${entry.name}/`, depth + 1);
        }
        continue;
      }
      if (!entry.name.endsWith(extension) || NOT_A_SOURCE.test(entry.name)) continue;
      const name = `${prefix}${entry.name.slice(0, -extension.length)}`;
      const valid = key === 'views' ? isViewName(name) : LOCALE.test(name) && name.length <= 35;
      if (!valid) {
        throw new DiscoveryError(
          key === 'views'
            ? `${pkg.name} has a file in its "views" whose path is no view name (segments of letters, digits, "_" and "-", joined by "/").`
            : `${pkg.name} has a file in its "lang" whose name is no language tag (such as en or de-AT).`,
        );
      }
      if (found.size >= options.max) {
        throw new DiscoveryError(`${pkg.name} lists more than ${options.max} files in its "${key}", the most one package may have.`);
      }
      found.set(name, realpathSync.native(path));
    }
  };
  walk(directory, '', 0);
  return found;
}

function sorted(found: Map<string, string>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/**
 * Resolves what a package's field declares: the `entry` subpaths and the files under the `views` and `lang` patterns of its `exports`,
 * under `conditions` (the ones the app resolves with). Everything must lie in the package, also by its real path. Reads package.json
 * and lists directories; runs no code of the package.
 */
export function resolveSurface(pkg: PackageInfo, field: PackageUiField, conditions: readonly string[]): PackageSurface {
  let entry: PackageSurface['entry'];
  if (field.entry !== undefined) {
    const resolve = (which: 'client' | 'ssr'): string => {
      const target = resolveExports(pkg, field.entry![which], conditions);
      if (target === undefined) {
        throw new DiscoveryError(`${pkg.name} declares an "entry" in its "marmeon" field, but its "exports" has no subpath for the ${which} entry that applies here.`);
      }
      if (!entryInside(pkg.dir, target)) {
        throw new DiscoveryError(`${pkg.name} maps the ${which} "entry" to a file outside the package.`);
      }
      try {
        return realpathSync.native(target);
      } catch {
        return target; // not built yet
      }
    };
    entry = { client: resolve('client'), ssr: resolve('ssr') };
  }
  const views = field.views === undefined ? new Map() : listPattern(pkg, field.views, 'views', conditions, { recursive: true, max: MAX_VIEWS });
  const lang = field.lang === undefined ? new Map() : listPattern(pkg, field.lang, 'lang', conditions, { recursive: false, max: MAX_LANG_FILES });
  return { package: pkg.name, namespace: field.namespace, ...(entry ? { entry } : {}), views: sorted(views), lang: sorted(lang) };
}
