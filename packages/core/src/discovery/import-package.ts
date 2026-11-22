/**
 * How discovery loads the modules of a package: by Node's `import()`, once per URL — or, in an app's tests, through the test's own module
 * runner (docs/vite.md#packages-of-your-workspace).
 */
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environment } from '../environment.ts';

/**
 * Where a test registers the function that imports a module of the app's workspace for discovery (the virtual module
 * `virtual:marmeon/test-packages` of `@marmeon/vite` does). A symbol of the global registry, so two copies of this package find the same function.
 *
 * Security invariant: the function is called only where `environment.isProtected()` is false — and that is asked here, on every call, not
 * where the function was registered. A global left in a process of production, of an unset, empty or unknown `NODE_ENV` is inert, whatever put it there.
 * What an unprotected boot already wrote onto a class (its injection list) stays for a later boot (docs/vite.md#packages-of-your-workspace).
 */
const TEST_IMPORT = Symbol.for('marmeon.test.import');

type Importer = (url: string) => Promise<Record<string, any>>;

/**
 * The test's importer, when this import is for it: a function is registered (looked at first, so nothing is read where none is), the
 * environment is development or test, and the file's real path has no `node_modules` segment. Any other case, a path that cannot be
 * read included, is Node's import.
 */
export function testImporter(url: string): Importer | undefined {
  const importer = (globalThis as Record<symbol, unknown>)[TEST_IMPORT];
  if (typeof importer !== 'function' || environment.isProtected()) return undefined;
  try {
    // An installed package stays with Node: a test's `vi.mock` of one must not change what boots. The real path decides — a workspace
    // package is linked into `node_modules`, and a link into an installed package leads back there.
    const segments = realpathSync.native(fileURLToPath(url)).split(sep === '\\' ? /[\\/]/ : sep);
    return segments.some((segment) => segment.toLowerCase() === 'node_modules') ? undefined : (importer as Importer);
  } catch {
    // not a file, or one that cannot be read: Node's import says why
    return undefined;
  }
}

/**
 * The discovered packages' modules, by URL, once per process. Node keeps a module by its URL anyway; under a module runner (Vitest)
 * every `import()` of a module it already ran is still a round trip to its server — and tests boot an app per test (under
 * load that made `createTestApp` take seconds). A failed import is not kept (a pruned install is discovered again).
 */
const packageModules = new Map<string, Promise<Record<string, any>>>();

/**
 * The module at `url` and whether the test's importer was asked for it. A routed module is never kept here, so the test and the booted app
 * share one instance (`vi.resetModules()` holds); its failure is the caller's and never falls back to Node, which would load a second copy.
 */
export function importModule(url: string): { module: Promise<Record<string, any>>; routed: boolean } {
  const importer = testImporter(url);
  if (importer) return { module: importer(url), routed: true };
  let module = packageModules.get(url);
  if (!module) {
    module = import(url) as Promise<Record<string, any>>;
    packageModules.set(url, module);
    module.catch(() => packageModules.delete(url));
  }
  return { module, routed: false };
}

/**
 * The module at `url` through the test's importer where `testImporter` gives one, else exactly what `load(url)` gives: no cache and no import
 * of its own here, so the caller's own `import()` stays the one that runs (docs/vite.md#packages-of-your-workspace).
 * @internal
 */
export function importPackage(url: string, load: (url: string) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const importer = testImporter(url);
  return importer ? importer(url) : load(url);
}
