import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication, Redactor, type Application, type ApplicationDefinition, type ApplicationPhase } from '@marmeon/core';
import { redactorFor } from '@marmeon/core/internal';
import { isLoaderCompileError, noteCompileFailure } from './load-failure.ts';

/** Imports `bootstrap/app.ts` — whose default export describes the app — and boots it (in the build phase: registers it). */
export async function loadApplication(root: string, phase: ApplicationPhase): Promise<Application | Error> {
  const entry = join(root, 'bootstrap', 'app.ts');
  if (!existsSync(entry)) return new Error(`No Marmeon app in ${root} (bootstrap/app.ts not found)`);
  try {
    const module = (await importObserved(pathToFileURL(entry).href)) as { default?: ApplicationDefinition };
    if (!module.default || typeof module.default.root !== 'string') {
      return new Error('bootstrap/app.ts must `export default defineApplication({ … })`.');
    }
    return await createApplication(module.default, phase === 'build' ? { phase } : {});
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * `import(href)`, watching which module Node loaded last, so that a syntax error V8 reports without a file (a duplicate `export`, an
 * invisible character in a regular expression) can name it, and its line, which comes from a second parse of the source the loader
 * compiled, by V8, on the failure path alone. The hook only looks: it passes `nextLoad`'s result on untouched, keeping a reference to it. With a
 * hook registered Node loads and compiles the static graph inside the `import()` call, each module right after its load, so the
 * module loaded last is the one that failed to compile — unless the import is not the only one running or a module awaits a dynamic
 * `import()` of its own; the count of loads says so, and the file is then left unnamed.
 */
async function importObserved(href: string): Promise<unknown> {
  let last: string | undefined;
  let lastLoaded: { format?: string | null; source?: unknown } | undefined;
  let count = 0;
  const recorder = registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      last = url;
      lastLoaded = loaded;
      count++;
      return loaded;
    },
  });
  try {
    const pending = import(href);
    // Taken now, before anything else runs: the static graph is done by the time `import()` returns its promise.
    const linked = { url: last, loaded: lastLoaded, count };
    try {
      return await pending;
    } catch (error) {
      if (linked.url !== undefined && count === linked.count && isLoaderCompileError(error)) noteCompileFailure(error, linked.url, linked.loaded);
      throw error;
    }
  } finally {
    recorder.deregister();
  }
}

/**
 * The redactor of the app's definition — the core's lists and the app's `redact` additions — for the report of an app that did not
 * start, which has no container to take it from. Imports `bootstrap/app.ts` as {@link loadApplication} did (from the module
 * cache); when the import or the additions throw, there is no definition to ask and the core's lists alone remain.
 */
export async function appRedactor(root: string): Promise<Redactor> {
  try {
    const module = (await import(pathToFileURL(join(root, 'bootstrap', 'app.ts')).href)) as { default?: ApplicationDefinition };
    return module.default ? redactorFor(module.default) : new Redactor();
  } catch {
    return new Redactor();
  }
}
