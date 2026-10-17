import { Application } from '@marmeon/core';
import type { AppCheck } from './registry.ts';
import type { CheckProblem } from './report.ts';
import { unlistedClasses } from '../unlisted.ts';

/**
 * Job and notification classes under `modules/` that no module lists — dispatching or sending one fails. A warning: the files
 * are parsed, never imported. See docs/check.md#the-checks.
 */
export class ModulesCheck implements AppCheck {
  static check = 'modules';
  static phase = 'build' as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  handle(): readonly CheckProblem[] {
    return unlistedClasses(this.#app.root, this.#app.modules).map(({ file, className, key, value }) => ({
      severity: 'warning',
      message:
        key === 'job'
          ? `${className} (static job '${value}') is in no module's jobs — dispatching it fails. Add it to jobs in its module's index.ts.`
          : `${className} (static notification '${value}') is in no module's notifications — sending it fails. Add it to notifications in its module's index.ts.`,
      file: file.split('\\').join('/'),
    }));
  }
}
