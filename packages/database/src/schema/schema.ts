import { withCode } from '@marmeon/core/internal';
import type { RawBuilder, RawNode } from 'kysely';
import type { Connection } from '../builder.ts';
import { isMigratorTable } from '../migration-state.ts';
import { lastSegment, rawText, statementWords } from '../migrator-connection.ts';
import { tableParts } from './table-name.ts';
import { Blueprint, blueprintParts, closedPlan } from './blueprint.ts';
import { hasExecutableComment } from './mysql-words.ts';
import type { Driver } from './blueprint.ts';
import type { DataContext, PlanStep, RawStatements } from './plan.ts';
import { SchemaError } from './schema-error.ts';

export { SchemaError };

let access: { steps(schema: Schema): readonly PlanStep[]; seal(schema: Schema): void; rolledBack(schema: Schema): void };

/** The steps a migration's `up()` or `down()` appended. Not API: the migrator reads them. */
export const schemaSteps = (schema: Schema): readonly PlanStep[] => access.steps(schema);

/** Closes a plan: the `Schema` refuses every call after `up()` or `down()` returned. Not API: the migrator does it. */
export const sealSchema = (schema: Schema): void => access.seal(schema);

/** Marks the plan as the one of a `down()`: it is not described by the migrations, so `create()` and `rename()` accept a name with a dot there. Not API: the migrator does it. */
export const rollbackSchema = (schema: Schema): void => access.rolledBack(schema);

/**
 * Builds the plan of a migration — what a migration gets. Nothing runs while `up()` or `down()` builds it: `migrate` runs the
 * steps in the migration's transaction, in the order they were added.
 *
 * ```ts
 * up: (schema) => schema.create('users', (table) => { table.id(); table.string('email').unique(); table.timestamps(); })
 * ```
 *
 * Changes of the data are steps of their own, `schema.data(async (db) => …)`; what the blueprint does not cover is
 * `schema.raw(sql\`…\`)`. See `docs/migrations.md#migration-structure`.
 */
export class Schema {
  readonly #steps: PlanStep[] = [];
  #sealed = false;
  #down = false;

  static {
    access = {
      steps: (schema) => schema.#steps,
      seal: (schema) => {
        schema.#sealed = true;
      },
      rolledBack: (schema) => {
        schema.#down = true;
      },
    };
  }

  #add(step: PlanStep): void {
    if (this.#sealed) throw closedPlan();
    this.#steps.push(step);
  }

  #rawNames(name: string, everywhere?: 'comment' | 'string'): never {
    throw new SchemaError(
      withCode(
        'D4',
        `The raw SQL names "${name}", a table of the migrator (as a table, column or alias${everywhere === 'comment' ? '; a statement with a /*! or /*+ comment is read with every word, those in strings and comments included' : everywhere === 'string' ? '; on SQLite the words of a string count too, because SQLite reads a string as a name where a name is expected' : ''}). Changing it would make it lose track of which migrations ran; choose another name. ` +
          'See docs/migrations.md#how-the-migrator-keeps-track.',
      ),
    );
  }

  /** Refuses a name the migrator keeps its tables under: `migrations` and `migration_lock`. */
  #allowed(table: string, action: string): void {
    // The last segment: `public.migrations` and `main.migrations` are the same table. And the table Kysely sends: `public. migrations` and `public.migrations.x` are the table `migrations` of `public`.
    if (!isMigratorTable(lastSegment(table)) && !isMigratorTable(tableParts(table).at(-1)!.name)) return;
    throw new SchemaError(
      withCode(
        'D4',
        `Cannot ${action} "${table}": the name belongs to the migrator, and changing it would make it lose track of which migrations ran. ` +
          'Choose another name. See docs/migrations.md#how-the-migrator-keeps-track.',
      ),
    );
  }

  /** Refuses, in an `up()`, a name Kysely splits at a dot: it names a table together with its schema or database, which the migrations do not describe, so `migrate` could not find it again. A `down()` is not checked against the migrations. */
  #unqualified(table: string, action: string): void {
    if (this.#down || !table.includes('.')) return;
    throw new SchemaError(
      withCode(
        'D31',
        `Cannot ${action} "${table}": a name with a dot names a table together with its schema or database, and the migrations do not describe such a table. Use a name without a dot. See docs/migrations.md#what-the-migrations-describe.`,
      ),
    );
  }

  /**
   * Refuses raw SQL that names a table of the migrator. Only a guard against mistakes: it reads the words of the statement, outside
   * its string literals, and does not parse it.
   */
  #rawAllowed(node: RawNode, driver: Driver): void {
    // The text as the driver's compiler sends it, read with the driver's own lexing (strings, quoted names, comments, dollar quotes, executable comments).
    const text = rawText(node, driver);
    for (const word of statementWords(text, driver)) if (isMigratorTable(word)) this.#rawNames(word, driver === 'mysql' && hasExecutableComment(text) ? 'comment' : driver === 'sqlite' ? 'string' : undefined);
  }

  /** Runs the callback that describes a table, and closes the description: it is synchronous like `up()`. */
  static #describe(table: string, build: (table: Blueprint) => void): Blueprint {
    const blueprint = new Blueprint(table);
    const result = build(blueprint) as unknown;
    blueprint.seal();
    if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
      (result as PromiseLike<unknown>).then(undefined, () => {});
      throw new Error(
        withCode('D14', `The callback that describes table "${table}" returned a promise. It runs while the plan is built and must be synchronous. See docs/migrations.md#migration-structure.`),
      );
    }
    return blueprint;
  }

  /** Adds the creation of a table. A name with a dot (a table with its schema or database) is refused with D31 in an `up()`; a table of the migrator is refused with D4 in both. See `docs/migrations.md#what-the-migrations-describe`. */
  create(table: string, build: (table: Blueprint) => void): void {
    this.#allowed(table, 'create the table');
    this.#unqualified(table, 'create the table');
    const blueprint = Schema.#describe(table, build);
    const parts = blueprintParts(blueprint);
    if (parts.columns.length === 0) throw new Error(`Table "${table}" needs at least one column.`);
    if (parts.drops.length || parts.renames.length || parts.dropIndexes.length || parts.nullability.length || parts.retirements.length || parts.dropChecks.length) {
      throw new Error('dropColumn(), renameColumn(), dropIndex(), dropCheck(), notNull(), nullable() and retire() only work when changing a table (schema.alter).');
    }
    if (parts.foreignKeys.length) throw new Error(`foreign('${parts.foreignKeys[0]!.column}') only works when changing a table (schema.alter): use foreignId(…).constrained() in create().`);
    if (parts.oneOfChanges.length) throw new Error(`oneOf('${parts.oneOfChanges[0]!.column}', …) only works when changing a table (schema.alter): use table.string('${parts.oneOfChanges[0]!.column}').oneOf(…) in create().`);
    this.#add({ kind: 'create', table, blueprint });
  }

  /**
   * Adds a change of a table. Every change runs as its own statement, because
   * SQLite's ALTER TABLE takes one change at a time. On SQLite a new NOT NULL column needs a default and cannot get a generated UUID
   * (`useUuidv7()`), and no column becomes NOT NULL or nullable (`notNull()`, `nullable()`) or gets a foreign key (`foreign()`) or a new list (`oneOf(column, values)`): `migrate` refuses such a plan before running any of its steps (error D18). See `docs/migrations.md#uuid-keys`, `docs/migrations.md#changing-the-data` and `docs/migrations.md#a-reference-that-comes-later` and `docs/migrations.md#check-constraints`.
   */
  alter(table: string, build: (table: Blueprint) => void): void {
    this.#allowed(table, 'alter the table');
    const blueprint = Schema.#describe(table, build);
    this.#add({ kind: 'alter', table, blueprint });
  }

  drop(table: string): void {
    this.#allowed(table, 'drop the table');
    this.#add({ kind: 'drop', table, ifExists: false });
  }

  dropIfExists(table: string): void {
    this.#allowed(table, 'drop the table');
    this.#add({ kind: 'drop', table, ifExists: true });
  }

  /**
   * Adds the renaming of a table. Its indexes and constraints keep their names, which begin with the old one (`notes_user_id_index`), unless
   * `indexes` is set: then those that begin with `<from>_` are renamed to begin with `<to>_` — so the table ends up as one
   * created under the new name (and, on Postgres, its identity sequences too). Opt-in: the default must not change what a
   * migration written earlier does. A new name with a dot is refused with D31 in an `up()`; a table of the migrator is refused with D4 in both. See `docs/migrations.md#what-the-migrations-describe`.
   */
  rename(from: string, to: string, options: { readonly indexes?: boolean } = {}): void {
    this.#allowed(from, 'rename the table');
    this.#allowed(to, 'rename a table to');
    this.#unqualified(to, 'rename a table to');
    this.#add({ kind: 'rename', from, to, indexes: options.indexes === true });
  }

  /**
   * Adds a step that changes data, between the schema steps around it: `db` is the migration's transaction. It cannot change the
   * schema (that is a step of its own) and cannot write to the migrator's tables. See `docs/migrations.md#changing-the-data`.
   */
  data(run: (db: Connection<any>, context: DataContext) => PromiseLike<unknown>): void {
    this.#add({ kind: 'data', run });
  }

  /**
   * Adds a statement the blueprint cannot write — one for every driver, or one per driver; SQLite and Postgres skip the step without a
   * statement, and a plan for MySQL needs a `mysql` statement, or `mysql: null` for nothing, or `migrate` refuses it. Marmeon does not look into it. See `docs/migrations.md#raw-sql`.
   */
  raw(statement: RawBuilder<unknown> | RawStatements): void {
    // A `RawBuilder` has `execute`; the per-driver form is a plain object.
    const statements: RawStatements = 'execute' in statement ? { sqlite: statement, pgsql: statement, mysql: statement } : statement;
    for (const driver of ['sqlite', 'pgsql', 'mysql'] as const) {
      const one = statements[driver];
      if (one) this.#rawAllowed(one.toOperationNode() as RawNode, driver);
    }
    this.#add({ kind: 'raw', statements });
  }
}
