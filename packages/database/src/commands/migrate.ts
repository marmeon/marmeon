import { relative } from 'node:path';
import type { CommandInput } from 'marmeon';
import { environment } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { confirmed } from './confirm.ts';
import { MigrationLockLostError, MigrationLockTimeoutError } from '../migrations/lock.ts';
import { Migrator, type ChangedMigration, type MigrateOptions, type MigrationRun } from '../migrations/migrator.ts';
import { TypeGenerator } from '../types-gen/generator.ts';
import { Seeding } from '../seeders.ts';
import { seed } from './db-seed.ts';
import { writeTypes } from './db-types.ts';

const force = { force: { type: 'boolean' } } as const;
const wait = { ...force, wait: { type: 'string' } } as const;

/**
 * Runs `work` under the migration lock, waiting `--wait` seconds (default 60) for another migration to end. Exit code 1 with the
 * holder when it does not; a lock taken over from a dead process is a warning.
 */
async function underLock(migrator: Migrator, { options, output }: CommandInput, work: () => Promise<number>): Promise<number> {
  const seconds = options.wait === undefined ? undefined : Number(options.wait);
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 0)) {
    output.error('--wait must be a whole number of seconds, 0 or more.');
    return 1;
  }
  migrator.lockWith({
    ...(seconds === undefined ? {} : { waitSeconds: seconds }),
    onTakeover: (previous) => output.warn(`Took over the migration lock of ${previous.owner}: its process is gone or showed no sign of life for ten minutes.`),
  });
  try {
    return await migrator.locked(work);
  } catch (error) {
    if (!(error instanceof MigrationLockTimeoutError || error instanceof MigrationLockLostError)) throw error;
    output.error(error.message);
    return 1;
  }
}

/** What a command says when it carried the record of migrations over from the form Marmeon 0.3 wrote. */
function carriedOver(output: CommandInput['output']): NonNullable<MigrateOptions['onCarriedOver']> {
  return ({ recorded, unknown }) =>
    output.info(`The record of migrations keeps a checksum per migration now: ${recorded} recorded as their files are now${unknown.length > 0 ? `, ${unknown.length} without a file stay unknown` : ''}.`);
}

const CHANGED_ADVICE =
  'The database has what the file said when it ran, and a migration that ran never runs again. Put the file back and write the change as a new migration — see docs/migrations.md#a-migration-that-changed-after-it-ran.';

/** What a command says before it runs or rolls back with migrations whose file changed after they ran: a warning each, then the advice once. */
function changedMigrations(output: CommandInput['output']): (changed: readonly ChangedMigration[]) => void {
  return (changed) => {
    for (const { name, module, batch } of changed) output.warn(`${name} (${module}) changed since it ran in batch ${batch}.`);
    output.line(CHANGED_ADVICE);
  };
}

/** What `migrate` says after a run: the tables 0.3 left, and what the database has that no migration made. */
function notices(output: CommandInput['output']): MigrateOptions {
  return {
    onCarriedOver: carriedOver(output),
    onChanged: changedMigrations(output),
    onLegacy: (connection, tables) =>
      output.info(`${tables.join(', ')} on the connection "${connection}" are left in place for processes of Marmeon 0.3; drop them once none runs.`),
    onUnknown: (connection, { tables, columns }) => {
      const listed = (names: readonly string[]) => `${names.slice(0, 5).join(', ')}${names.length > 5 ? `, and ${names.length - 5} more` : ''}`;
      if (tables.length > 0) {
        output.info(
          `The database connection "${connection}" has tables no migration made: ${listed(tables)}. Marmeon does not know them: they are unprotected (no secret columns, soft deletes or timestamps). ` +
            'To give one secret columns or soft deletes, create a new table with schema.create() and copy the rows over; type a table of another tool with withTables<…>().',
        );
      }
      if (columns.length > 0) {
        output.warn(
          `The database connection "${connection}" has columns no migration added: ${listed(columns)}. selectAll() leaves them out; name them in a query to read them, ` +
            'or add them with schema.alter() so that Marmeon knows them.',
        );
      }
    },
  };
}

function report(output: CommandInput['output'], verb: string) {
  return (run: MigrationRun) => output.success(`${verb} ${run.name} (${run.module}) ${run.ms.toFixed(1)} ms`);
}

/**
 * After new migrations ran: regenerate the table types — with `NODE_ENV=development` only. Anywhere else
 * (production, a test) the committed file is final, and the app directory may not even be writable.
 */
async function afterMigrating(generator: TypeGenerator, input: CommandInput, types: boolean): Promise<void> {
  if (!types || !environment.isDevelopment()) return;
  await writeTypes(generator, input.output, input.root);
}

/** Before anything runs: whether development would write the types afterwards over a file of a newer format — then nothing runs. */
function blockedByNewerTypes(generator: TypeGenerator, { options, output, root }: CommandInput): boolean {
  if (options['no-types'] === true || !environment.isDevelopment()) return false;
  if (generator.fileFormat() !== 'newer') return false;
  output.error(withCode('D7', `${relative(root, generator.path)} was generated by a newer version of Marmeon — update @marmeon/*; nothing was migrated (--no-types skips this check).`));
  return true;
}

/** Runs every pending migration of every module, in one batch, then updates the table types. */
export class MigrateCommand {
  static command = 'migrate';
  static description = 'Run the pending migrations';
  static usage = '[--force] [--wait=<seconds>] [--no-types]';
  static options = { ...wait, 'no-types': { type: 'boolean' } } as const;

  readonly #migrator: Migrator;
  readonly #types: TypeGenerator;

  /** @internal The container builds the command. */
  constructor(migrator: Migrator, types: TypeGenerator) {
    this.#migrator = migrator;
    this.#types = types;
  }

  async handle(input: CommandInput): Promise<number> {
    if (!confirmed(input, 'migrate') || blockedByNewerTypes(this.#types, input)) return 1;
    return underLock(this.#migrator, input, async () => {
      const runs = await this.#migrator.migrate(report(input.output, 'Migrated'), notices(input.output));
      if (runs.length === 0) input.output.info('Nothing to migrate.');
      await afterMigrating(this.#types, input, runs.length > 0 && input.options['no-types'] !== true);
      return 0;
    });
  }
}

export class MigrateRollbackCommand {
  static command = 'migrate:rollback';
  static description = 'Roll back the last batch of migrations (or --step=n migrations)';
  static usage = '[--step=<n>] [--force] [--wait=<seconds>]';
  static options = { ...wait, step: { type: 'string' } } as const;

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
    return underLock(this.#migrator, input, async () => {
      const runs = await this.#migrator.rollback({ steps: step, onCarriedOver: carriedOver(input.output), onChanged: changedMigrations(input.output) }, report(input.output, 'Rolled back'));
      if (runs.length === 0) input.output.info('Nothing to roll back.');
      return 0;
    });
  }
}

export class MigrateResetCommand {
  static command = 'migrate:reset';
  static description = 'Roll back every migration';
  static usage = '[--force] [--wait=<seconds>]';
  static options = wait;

  readonly #migrator: Migrator;

  constructor(migrator: Migrator) {
    this.#migrator = migrator;
  }

  async handle(input: CommandInput): Promise<number> {
    if (!confirmed(input, 'roll back every migration')) return 1;
    return underLock(this.#migrator, input, async () => {
      const runs = await this.#migrator.reset(report(input.output, 'Rolled back'), { onCarriedOver: carriedOver(input.output), onChanged: changedMigrations(input.output) });
      if (runs.length === 0) input.output.info('Nothing to roll back.');
      return 0;
    });
  }
}

export class MigrateFreshCommand {
  static command = 'migrate:fresh';
  static description = 'Drop every table and run all migrations (--seed: then the seeders)';
  static usage = '[--seed] [--force] [--wait=<seconds>] [--no-types]';
  static options = { ...wait, 'no-types': { type: 'boolean' }, seed: { type: 'boolean' } } as const;

  readonly #migrator: Migrator;
  readonly #types: TypeGenerator;
  readonly #seeding: Seeding;

  /** @internal The container builds the command. */
  constructor(migrator: Migrator, types: TypeGenerator, seeding: Seeding) {
    this.#migrator = migrator;
    this.#types = types;
    this.#seeding = seeding;
  }

  async handle(input: CommandInput): Promise<number> {
    if (!confirmed(input, 'drop every table') || blockedByNewerTypes(this.#types, input)) return 1;
    const migrated = await underLock(this.#migrator, input, async () => {
      const connections = await this.#migrator.dropAllTables();
      input.output.info(connections.length === 1 ? 'Dropped all tables.' : `Dropped all tables of the connections ${connections.join(', ')}.`);
      const runs = await this.#migrator.migrate(report(input.output, 'Migrated'), notices(input.output));
      await afterMigrating(this.#types, input, runs.length > 0 && input.options['no-types'] !== true);
      return 0;
    });
    return migrated === 0 && input.options.seed === true ? seed(this.#seeding, input) : migrated;
  }
}

/** Lists every migration with its batch or `Pending`; `--json` prints the document described in docs/migrations.md#status. */
export class MigrateStatusCommand {
  static command = 'migrate:status';
  static description = 'Show which migrations have run';
  static usage = '[--json]';
  static options = { json: { type: 'boolean' } } as const;

  readonly #migrator: Migrator;

  constructor(migrator: Migrator) {
    this.#migrator = migrator;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const migrations = (await this.#migrator.status()).map((m) => ({
      name: m.name,
      module: m.module,
      batch: m.batch ?? null,
      status: m.batch === undefined ? ('pending' as const) : ('ran' as const),
    }));
    const changed = await this.#migrator.changed();
    const warnings = [
      ...(await this.#migrator.missing()).map((m) => `${m.name} ran in batch ${m.batch} but no module has its file`),
      ...changed.map((m) => `${m.name} changed since it ran in batch ${m.batch}`),
    ];
    if (options.json === true) {
      output.json({ format: 1, migrations, warnings });
      return 0;
    }
    for (const warning of warnings) output.warn(warning);
    if (changed.length > 0) output.line(CHANGED_ADVICE);
    if (migrations.length === 0) {
      output.info('No migrations. Add a directory to a module: defineModule({ migrations: new URL(\'./migrations/\', import.meta.url) }).');
      return 0;
    }
    output.table(
      ['MIGRATION', 'MODULE', 'BATCH / STATUS'],
      migrations.map((m) => [m.name, m.module, m.batch === null ? 'Pending' : `[${m.batch}] Ran`]),
    );
    return 0;
  }
}
