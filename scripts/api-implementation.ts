/**
 * Libraries a package builds on and that no name or type of the package may show (`pnpm api:check`; CONTRIBUTING.md, "The API
 * snapshot"). The package may replace the library — a fork, another package — without an app noticing, only while nothing public
 * names it: not a declaration file, not the snapshot, and no source file but the one that adapts it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importsOf } from './api-sources.ts';
import type { SourceFile } from './source-files.ts';

export interface ImplementationLists {
  /** Per package name, the libraries it builds on without showing them. */
  readonly only: Readonly<Record<string, readonly string[]>>;
  /** The files of a package's `src/` that may import them (repository paths) — the adapter and its compatibility test. */
  readonly importers: Readonly<Record<string, readonly string[]>>;
}

export const IMPLEMENTATION_ONLY: Readonly<Record<string, readonly string[]>> = {
  // The components of `@marmeon/react/mail` stand on it; their names and props are Marmeon's own (docs/mail.md#mail-views-in-react).
  '@marmeon/react': ['@faire/mjml-react'],
};

/** The only files that import a library of `IMPLEMENTATION_ONLY`: the adapter and the type test that holds the two together. */
export const IMPLEMENTATION_IMPORTERS: Readonly<Record<string, readonly string[]>> = {
  '@marmeon/react': ['packages/react/src/mail/implementation.ts', 'packages/react/src/mail/implementation.type-test.ts'],
};

const LISTS: ImplementationLists = { only: IMPLEMENTATION_ONLY, importers: IMPLEMENTATION_IMPORTERS };

/** Every `.d.ts` under `dir`. */
function declarationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? declarationFiles(join(entry.parentPath, entry.name)) : entry.name.endsWith('.d.ts') ? [join(entry.parentPath, entry.name)] : []));
}

const names = (text: string, library: string) => text.includes(`'${library}`) || text.includes(`"${library}`) || text.includes(`\`${library}`);

/**
 * What shows a library of `lists.only` outside its adapter: a `.d.ts` under the package's `dist/` that names it (an import,
 * `import('…')`, a re-export — also a file no entry point reaches), its `api.md` under "Types from other packages", or a source
 * file of the package that imports it and is not in `lists.importers`.
 */
export function implementationProblems(packages: readonly { readonly name: string; readonly dir: string; readonly short: string }[], files: readonly SourceFile[], lists: ImplementationLists = LISTS): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const library of lists.only[pkg.name] ?? []) {
      const own = `packages/${pkg.short}/`;
      for (const path of declarationFiles(join(pkg.dir, 'dist'))) {
        // Tests are not packed (`files` leaves them out), and the type test of a replacement names the library by design.
        if (/\.(?:type-)?test\.d\.ts$/.test(path)) continue;
        if (names(readFileSync(path, 'utf8'), library)) problems.push(`${pkg.name}: ${own}${path.slice(pkg.dir.length + 1).split('\\').join('/')} names ${library}, which is for the implementation only — no name or type of it may be public`);
      }
      const snapshot = join(pkg.dir, 'api.md');
      if (existsSync(snapshot) && new RegExp(`^Types from other packages: .*\`${library.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\``, 'm').test(readFileSync(snapshot, 'utf8'))) {
        problems.push(`${pkg.name}: ${own}api.md lists ${library} under "Types from other packages" — it is for the implementation only`);
      }
      const allowed = lists.importers[pkg.name] ?? [];
      for (const file of files) {
        if (!file.path.startsWith(`${own}src/`) || allowed.includes(file.path)) continue;
        if (importsOf(file.text).some((found) => found.specifier === library || found.specifier.startsWith(`${library}/`))) {
          problems.push(`${file.path} imports ${library}, which only ${allowed.join(' and ') || 'nothing'} may — the rest of ${pkg.name} goes through that adapter`);
        }
      }
    }
  }
  return problems;
}
