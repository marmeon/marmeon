import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { belongsTo, isInside, isNamespace, isViewName, packageSurfaces, type PackageSurface } from '@marmeon/core/internal';
import { normalizePath, type Plugin } from 'vite';

/** A template carrying this comment is a package's own document: the plugin injects no app client into it. */
export const PACKAGE_ENTRY_MARK = '<!--marmeon:package-entry-->';

const PAGES_PREFIX = 'virtual:marmeon/pages/';

/**
 * A string literal for generated module code. `JSON.stringify` alone leaves `<`, `>` and the line separators U+2028/U+2029 raw;
 * a path holding them must not be able to end the literal or the module's context.
 */
export function codeString(value: string): string {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Every installed package that declares a namespace, with the real directory discovery found it in (`dir`). */
export function uiPackages(root: string, conditions: readonly string[]): readonly PackageSurface[] {
  // An app without a readable package.json has no packages to read; the check that names that file's problem runs elsewhere (H14).
  try {
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  return packageSurfaces({ root, conditions });
}

/** The files and folders of the packages that get the app's plugin chain: names, real directories, client entries. */
export function uiPackageSettings(packages: readonly PackageSurface[]): { names: string[]; directories: string[]; clientEntries: string[] } {
  return {
    names: packages.map((surface) => surface.package),
    directories: packages.map((surface) => surface.dir),
    clientEntries: packages.flatMap((surface) => (surface.entry === undefined ? [] : [surface.entry.client])),
  };
}

/**
 * `virtual:marmeon/pages/<namespace>` — the pages of a package with an entry, keyed `<namespace>::<view>` and loaded lazily. Paths are
 * real paths, because a package installed below another is not resolvable from the app. A namespace no package declares, or one whose
 * package has no pages, is an error: an empty module would hide a typo.
 */
export function packagePages(packages: () => readonly PackageSurface[]): Plugin {
  const find = (namespace: string): PackageSurface | undefined => {
    if (!isNamespace(namespace)) return undefined;
    const found = packages().find((surface) => surface.namespace === namespace);
    return found?.entry === undefined ? undefined : found;
  };
  return {
    name: 'marmeon:package-pages',
    resolveId(source) {
      if (!source.startsWith(PAGES_PREFIX)) return undefined;
      if (find(source.slice(PAGES_PREFIX.length)) === undefined) {
        this.error(`${JSON.stringify(source)}: no installed package declares that namespace together with an entry and views in its "marmeon" field.`);
      }
      return `\0${source}`;
    },
    load(id) {
      if (!id.startsWith(`\0${PAGES_PREFIX}`)) return undefined;
      const found = find(id.slice(PAGES_PREFIX.length + 1));
      if (found === undefined) this.error(`${JSON.stringify(id.slice(1))}: no installed package declares that namespace together with an entry and views in its "marmeon" field.`);
      const surface = found;
      const directory = surface.dir;
      const entries: string[] = [];
      for (const [view, file] of Object.entries(surface.views)) {
        if (!isViewName(view)) this.error(`${surface.package} lists a view whose name is no view name.`);
        // Checked again here: a link swapped in since the discovery must not lead a page out of the package.
        let real: string;
        try {
          real = realpathSync.native(file);
        } catch {
          this.error(`${surface.package} lists a view that cannot be read.`);
        }
        if (!isInside(directory, real) || !belongsTo(directory, real)) this.error(`${surface.package} lists a view that lies outside the package.`);
        entries.push(`  ${codeString(`${surface.namespace}::${view}`)}: () => import(${codeString(normalizePath(real))}),`);
      }
      return `export default {\n${entries.join('\n')}\n};\n`;
    },
  };
}
