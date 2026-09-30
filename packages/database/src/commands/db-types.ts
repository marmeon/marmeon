import { relative } from 'node:path';
import type { CommandInput } from '@bespokecore/cli';
import { TypeGenerator } from '../types-gen/generator.ts';

/**
 * Generates the table types from the migrations (`bootstrap/database.d.ts`). `--check` only
 * compares — for CI: it fails when someone changed a migration without regenerating.
 */
export class DbTypesCommand {
  static command = 'db:types';
  static description = 'Generate the table types from the migrations (--check: fail if outdated)';
  static usage = '[--check]';
  static options = { check: { type: 'boolean' } } as const;

  readonly #generator: TypeGenerator;

  constructor(generator: TypeGenerator) {
    this.#generator = generator;
  }

  async handle({ options, output, root }: CommandInput): Promise<number> {
    const file = relative(root, this.#generator.path);
    if (options.check === true) {
      if (await this.#generator.isCurrent()) {
        output.success(`${file} matches the migrations.`);
        return 0;
      }
      output.error(`${file} is out of date — run: bespoke db:types`);
      return 1;
    }
    await writeTypes(this.#generator, output, root);
    return 0;
  }
}

/** Writes the types and reports it — also after `migrate`. */
export async function writeTypes(generator: TypeGenerator, output: CommandInput['output'], root: string): Promise<void> {
  const { changed, warnings } = await generator.write();
  for (const warning of warnings) output.warn(warning);
  const file = relative(root, generator.path);
  if (changed) output.success(`Wrote ${file}`);
  else output.info(`${file} is up to date.`);
}
