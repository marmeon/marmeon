import { relative } from 'node:path';
import type { CommandInput } from '../command.ts';
import { RouteTypes } from '../route-types.ts';

/**
 * Generates `bootstrap/routes.ts` — route names, parameters, methods and controllers for the type checker, and the
 * views (E34) — plus `.bespoke/routes.json`, the routes the browser may learn, for the `bespoke()` Vite plugin (E57).
 * `--check` only compares the committed file, for CI: it fails when someone changed routes or views without
 * regenerating. `bespoke dev` and `bespoke build` run it themselves.
 */
export class RouteTypesCommand {
  static command = 'route:types';
  static description = 'Generate bootstrap/routes.ts from the routes and views (--check: fail if outdated)';
  static usage = '[--check]';
  static options = { check: { type: 'boolean' } } as const;

  readonly #types: RouteTypes;

  constructor(types: RouteTypes) {
    this.#types = types;
  }

  async handle({ options, output, root }: CommandInput): Promise<number> {
    const file = relative(root, this.#types.path);
    if (options.check === true) {
      if (await this.#types.isCurrent()) {
        output.success(`${file} matches the routes and views.`);
        return 0;
      }
      output.error(`${file} is out of date — run: bespoke route:types`);
      return 1;
    }
    await writeRouteTypes(this.#types, output, root);
    return 0;
  }
}

/** Writes the file and reports it — `quiet` says nothing when it is unchanged (`bespoke dev`). */
export async function writeRouteTypes(types: RouteTypes, output: CommandInput['output'], root: string, { quiet = false } = {}): Promise<boolean> {
  const { changed, warnings } = await types.write();
  for (const warning of warnings) output.warn(warning);
  const file = relative(root, types.path);
  if (changed) output.success(`Wrote ${file}`);
  else if (!quiet) output.info(`${file} is up to date.`);
  return changed;
}
