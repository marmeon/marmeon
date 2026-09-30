import type { CommandInput } from '@bespokecore/cli';
import { Seeding } from '../seeders.ts';

/** Laravel's `db:seed`: runs the modules' seeders (`--module=auth`, `--class=DemoUsersSeeder`). */
export class DbSeedCommand {
  static command = 'db:seed';
  static description = 'Seed the database with the modules’ seeders';
  static usage = '[--module=<module>] [--class=<Seeder>] [--force]';
  static options = { module: { type: 'string' }, class: { type: 'string' }, force: { type: 'boolean' } } as const;

  readonly #seeding: Seeding;

  constructor(seeding: Seeding) {
    this.#seeding = seeding;
  }

  async handle(input: CommandInput): Promise<number> {
    if (process.env.NODE_ENV === 'production' && input.options.force !== true) {
      input.output.error('The application is in production. Pass --force to seed.');
      return 1;
    }
    return seed(this.#seeding, input);
  }
}

/** Runs the seeders the options select; an unknown module or class is a usage error, not a crash. */
export async function seed(seeding: Seeding, { options, output }: CommandInput): Promise<number> {
  const filter = {
    module: typeof options.module === 'string' ? options.module : undefined,
    seeder: typeof options.class === 'string' ? options.class : undefined,
  };
  let seeders;
  try {
    seeders = seeding.seeders(filter);
  } catch (error) {
    output.error((error as Error).message);
    return 1;
  }
  if (seeders.length === 0) {
    output.info('No seeders. Add them to a module: defineModule({ seeders: [DemoUsersSeeder] }).');
    return 0;
  }
  await seeding.run(filter, (run) => output.success(`Seeded ${run.seeder} (${run.module}) ${run.ms.toFixed(1)} ms`));
  return 0;
}
