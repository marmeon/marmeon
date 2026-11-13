import { readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/** The file that tells the server which manifest key starts each package entry and holds each package page (docs/vite.md#building). */
export const ENTRIES_FILE = '.vite/marmeon-entries.json';

/** The packages whose entry the client build takes as an input of its own. */
export function entryPackages(packages: readonly PackageSurface[]): PackageSurface[] {
  return packages.filter((surface) => surface.entry !== undefined);
}

/** Module id of a file as Vite's bundler names it. */
function moduleId(file: string): string {
  return normalizePath(realpathSync.native(file));
}

/** The client build's inputs and the name each entry's chunks take: `index` for the app's `index.html`, `pkg-<namespace>` for a package. */
export function clientInputs(root: string, packages: readonly PackageSurface[]): { input: Record<string, string>; names: Map<string, string> } {
  const html = normalizePath(join(root, 'index.html'));
  const input: Record<string, string> = { index: html };
  const names = new Map<string, string>([[html, 'index']]);
  for (const surface of entryPackages(packages)) {
    const file = moduleId(surface.entry!.client);
    input[`pkg-${surface.namespace}`] = file;
    names.set(file, `pkg-${surface.namespace}`);
  }
  return { input, names };
}

/** The server build's inputs: the app's `ssr` and `ssr-<namespace>` for each package with an entry, written as `dist/server/ssr-<namespace>.js`. */
export function serverInputs(appEntry: string, packages: readonly PackageSurface[]): Record<string, string> {
  const input: Record<string, string> = { ssr: appEntry };
  for (const surface of entryPackages(packages)) input[`ssr-${surface.namespace}`] = moduleId(surface.entry!.ssr);
  return input;
}

/**
 * Writes `.vite/marmeon-entries.json` into the client build when a package has an entry: `entries` maps each namespace to the manifest key of
 * its client entry, `pages` each `<namespace>::<view>` the build made a chunk of to its manifest key. A view no chunk starts at is left out,
 * so every key listed is in `.vite/manifest.json`.
 */
export function entriesFile(root: () => string, packages: () => readonly PackageSurface[]): Plugin {
  return {
    name: 'marmeon:entries-file',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return;
      const withEntry = entryPackages(packages());
      if (withEntry.length === 0) return;
      // Vite's manifest names a chunk by its starting module, relative to the root.
      const keys = new Map<string, string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.facadeModuleId !== null && (chunk.isEntry || chunk.isDynamicEntry)) {
          keys.set(normalizePath(chunk.facadeModuleId), normalizePath(relative(root(), chunk.facadeModuleId)));
        }
      }
      const entries: Record<string, { client: string }> = {};
      const pages: Record<string, string> = {};
      for (const surface of [...withEntry].sort((a, b) => (a.namespace < b.namespace ? -1 : 1))) {
        const client = keys.get(moduleId(surface.entry!.client));
        if (client === undefined) this.error(`${surface.package} has a client entry that the build left out.`);
        entries[surface.namespace] = { client };
        for (const [view, file] of Object.entries(surface.views)) {
          const key = keys.get(moduleId(file));
          if (key !== undefined) pages[`${surface.namespace}::${view}`] = key;
        }
      }
      this.emitFile({ type: 'asset', fileName: ENTRIES_FILE, source: `${JSON.stringify({ format: 1, entries, pages }, null, 2)}\n` });
    },
  };
}
