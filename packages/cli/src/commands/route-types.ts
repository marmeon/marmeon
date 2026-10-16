import { relative } from 'node:path';
import { Application, Redactor } from '@marmeon/core';
import { Router } from '@marmeon/router';
import { formatAccessProblems } from '@marmeon/router/internal';
import type { CommandInput } from '../command.ts';
import { RouteTypes } from '../route-types.ts';

/**
 * Generates `bootstrap/routes.ts` — route names, parameters, methods and controllers for the type checker, and the
 * views — plus `.marmeon/routes.json`, the routes the browser may learn, for the `marmeon()` Vite plugin.
 * `--check` only compares the committed file, for CI: it fails when someone changed routes or views without
 * regenerating. `marmeon dev` and `marmeon build` run it themselves.
 */
export class RouteTypesCommand {
  static command = 'route:types';
  static description = 'Generate bootstrap/routes.ts from the routes and views (--check: fail if outdated)';
  static usage = '[--check]';
  static options = { check: { type: 'boolean' } } as const;
  /** Routes and views are all it reads: the app registers, boots nothing and needs no secret — `marmeon build` runs it so. */
  static boots = 'build' as const;

  readonly #types: RouteTypes;
  readonly #router: Router;
  readonly #app: Application;

  constructor(types: RouteTypes, router: Router, app: Application) {
    this.#types = types;
    this.#router = router;
    this.#app = app;
  }

  async handle({ options, output, root }: CommandInput): Promise<number> {
    const file = relative(root, this.#types.path);
    let status = 0;
    if (options.check === true) {
      if (await this.#types.isCurrent()) output.success(`${file} matches the routes and views.`);
      else {
        output.error(`${file} is out of date — run: marmeon route:types`);
        status = 1;
      }
    } else {
      await writeRouteTypes(this.#types, output, root);
    }
    // After the file is written, so that fixing the routes is not made harder by type errors about missing route names.
    // `marmeon build` runs this command and stops on a non-zero exit.
    const problems = this.#router.accessProblems();
    if (problems.length > 0) {
      // Build and CI logs: the paths go through the app's redactor, as the kernel's message does.
      const redactor = this.#app.container.has(Redactor) ? this.#app.container.make(Redactor) : new Redactor();
      output.error(formatAccessProblems(problems, { path: (route) => redactor.path(route.path, route.path) }));
      return 1;
    }
    return status;
  }
}

/** Writes the file and reports it — `quiet` says nothing when it is unchanged (`marmeon dev`). */
export async function writeRouteTypes(types: RouteTypes, output: CommandInput['output'], root: string, { quiet = false } = {}): Promise<boolean> {
  const { changed, warnings } = await types.write();
  for (const warning of warnings) output.warn(warning);
  const file = relative(root, types.path);
  if (changed) output.success(`Wrote ${file}`);
  else if (!quiet) output.info(`${file} is up to date.`);
  return changed;
}
