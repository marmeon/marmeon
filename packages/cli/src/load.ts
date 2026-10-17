import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication, type Application, type ApplicationDefinition, type ApplicationPhase } from '@marmeon/core';

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
