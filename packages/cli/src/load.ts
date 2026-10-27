import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication, Redactor, type Application, type ApplicationDefinition, type ApplicationPhase } from '@marmeon/core';
import { redactorFor } from '@marmeon/core/internal';

/** Imports `bootstrap/app.ts` — whose default export describes the app — and boots it (in the build phase: registers it). */
export async function loadApplication(root: string, phase: ApplicationPhase): Promise<Application | Error> {
  const entry = join(root, 'bootstrap', 'app.ts');
  if (!existsSync(entry)) return new Error(`No Marmeon app in ${root} (bootstrap/app.ts not found)`);
  try {
    const module = (await import(pathToFileURL(entry).href)) as { default?: ApplicationDefinition };
    if (!module.default || typeof module.default.root !== 'string') {
      return new Error('bootstrap/app.ts must `export default defineApplication({ … })`.');
    }
    return await createApplication(module.default, phase === 'build' ? { phase } : {});
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
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
