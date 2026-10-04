import type { CommandInput } from '@bespokecore/cli';
import { environment } from '@bespokecore/core';
import { confirmed } from './confirm.ts';
import { Migrator, type MigrationRun } from '../migrations/migrator.ts';
import { TypeGenerator } from '../types-gen/generator.ts';
import { Seeding } from '../seeders.ts';
import { seed } from './db-seed.ts';
import { writeTypes } from './db-types.ts';

const force = { force: { type: 'boolean' } } as const;

function report(output: CommandInput['output'], verb: string) {
  return (run: MigrationRun) => output.success(`${verb} ${run.name} (${run.module}) ${run.ms.toFixed(1)} ms`);
}

/**
 * After new migrations ran: regenerate the table types — with `NODE_ENV=development` only (E164). Anywhere else (staging,
 * production, a test) the committed file is final, and the app directory may not even be writable.
 */
async function afterMigrating(generator: TypeGenerator, input: CommandInput, types: boolean): Promise<void> {
  if (!types || !environment.isDevelopment()) return;
  await writeTypes(generator, input.output, input.root);
}

/** Laravel's `migrate`: runs every pending migration of every module, in one batch, then updates the table types. */
export class MigrateCommand {
  static command = 'migrate';
  static description = 'Run the pending migrations';
  static usage = '[--force] [--no-types]';
  static options = { ...force, 'no-types': { type: 'boolean' } } as const;

  readonly #migrator: Migrator;
  readonly #types: TypeGenerator;

  constructor(migrator: Migrator, types: TypeGenerator) {
    this.#migrator = migrator;
    this.#types = types;
  }

  async handle(input: CommandInput): Promise<number> {
    if (!confirmed(input, 'migrate')) return 1;
    const runs = await this.#migrator.migrate(report(input.output, 'Migrated'));
    if (runs.length === 0) input.output.info('Nothing to migrate.');
    await afterMigrating(this.#types, input, runs.length > 0 && input.options['no-types'] !== true);
    return 0;
  }
}

export class MigrateRollbackCommand {
  static command = 'migrate:rollback';
  static description = 'Roll back the last batch of migrations (or --step=n migrations)';
  static usage = '[--step=<n>] [--force]';
  static options = { ...force, step: { type: 'string' } } as const;

  readonly #migrator: Migrator;

  constructor(migrator: Migrator) {
    this.#migrator = migrator;
  }

  async handle(input: CommandInput): Promise<number> {
    const step = input.options.step === undefined ? undefined : Number(input.options.step);
    if (step !== undefined && (!Number.isInteger(step) || step < 1)) {
      input.output.error('--step must be a positive whole number.');
      return 1;
    }
    if (!confirmed(input, 'roll back')) return 1;
    const runs = await this.#migrator.rollback({ steps: step }, report(input.output, 'Rolled back'));
    if (runs.length === 0) input.output.info('Nothing to roll back.');
    return 0;
  }
}

export class MigrateResetCommand {
  static command = 'migrate:reset';
  static description = 'Roll back every migration';
  static usage = '[--force]';
  static options = force;

  readonly #migrator: Migrator;

  constructor(migrator: Migrator) {
    this.#migrator = migrator;
  }

  async handle(input: CommandInput): Promise<number> {
    if (!confirmed(input, 'roll back every migration')) return 1;
    const runs = await this.#migrator.reset(report(input.output, 'Rolled back'));
    if (runs.length === 0) input.output.info('Nothing to roll back.');
    return 0;
  }
}

export class MigrateFreshCommand {
  static command = 'migrate:fresh';
  static description = 'Drop every table and run all migrations (--seed: then the seeders)';
  static usage = '[--seed] [--force] [--no-types]';
  static options = { ...force, 'no-types': { type: 'boolean' }, seed: { type: 'boolean' } } as const;

  readonly #migrator: Migrator;
  readonly #types: TypeGenerator;
  readonly #seeding: Seeding;

  constructor(migrator: Migrator, types: TypeGenerator, seeding: Seeding) {
    this.#migrator = migrator;
    this.#types = types;
    this.#seeding = seeding;
  }

  async handle(input: CommandInput): Promise<number> {
    if (!confirmed(input, 'drop every table')) return 1;
    const connections = await this.#migrator.dropAllTables();
    input.output.info(connections.length === 1 ? 'Dropped all tables.' : `Dropped all tables of the connections ${connections.join(', ')}.`);
    const runs = await this.#migrator.migrate(report(input.output, 'Migrated'));
    await afterMigrating(this.#types, input, runs.length > 0 && input.options['no-types'] !== true);
    return input.options.seed === true ? seed(this.#seeding, input) : 0;
  }
}

export class MigrateStatusCommand {
  static command = 'migrate:status';
  static description = 'Show which migrations have run';

  readonly #migrator: Migrator;

  constructor(migrator: Migrator) {
    this.#migrator = migrator;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const status = await this.#migrator.status();
    if (status.length === 0) {
      output.info('No migrations. Add a directory to a module: defineModule({ migrations: new URL(\'./migrations/\', import.meta.url) }).');
      return 0;
    }
    output.table(
      ['MIGRATION', 'MODULE', 'BATCH / STATUS'],
      status.map((m) => [m.name, m.module, m.batch === undefined ? 'Pending' : `[${m.batch}] Ran`]),
    );
    return 0;
  }
}
