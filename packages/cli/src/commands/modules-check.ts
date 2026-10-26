import { Application } from '@marmeon/core';
import type { CommandInput } from '../command.ts';
import { warnUnlisted } from '../unlisted.ts';

/**
 * Warns about job and notification classes under `modules/` that no module lists. Only a warning, exit 0; the files are
 * parsed, never imported. A step of `marmeon build`, which runs it; `marmeon dev` does the same at its start.
 */
export class ModulesCheckCommand {
  static command = 'modules:check';
  static description = 'Warn about job and notification classes no module lists';
  static hidden = true;
  /** Registers the modules and boots nothing, like `route:types` — `marmeon build` runs it without secrets. */
  static boots = 'build' as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  handle({ output, root }: CommandInput): number {
    warnUnlisted(output, root, this.#app.modules);
    return 0;
  }
}
