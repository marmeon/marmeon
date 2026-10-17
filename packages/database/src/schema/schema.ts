import { withCode } from '@marmeon/core/internal';
import type { RawBuilder, RawNode } from 'kysely';
import type { Connection } from '../builder.ts';
import { isMigratorTable } from '../migration-state.ts';
import { lastSegment, rawText } from '../migrator-connection.ts';
import { Blueprint, closedPlan } from './blueprint.ts';
import type { DataContext, PlanStep, RawStatements } from './plan.ts';
import { SchemaError } from './schema-error.ts';

export { SchemaError };

let access: { steps(schema: Schema): readonly PlanStep[]; seal(schema: Schema): void };

/** The steps a migration's `up()` or `down()` appended. Not API: the migrator reads them. */
export const schemaSteps = (schema: Schema): readonly PlanStep[] => access.steps(schema);

/** Closes a plan: the `Schema` refuses every call after `up()` or `down()` returned. Not API: the migrator does it. */
export const sealSchema = (schema: Schema): void => access.seal(schema);

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

  static {
    access = {
      steps: (schema) => schema.#steps,
      seal: (schema) => {
        schema.#sealed = true;
      },
    };
  }

  #add(step: PlanStep): void {
    if (this.#sealed) throw closedPlan();
    this.#steps.push(step);
  }

  #rawNames(name: string): never {
    throw new SchemaError(
      withCode(
        'D4',
        `The raw SQL names "${name}", a table of the migrator (as a table, column or alias). Changing it would make it lose track of which migrations ran; choose another name. ` +
          'See docs/migrations.md#how-the-migrator-keeps-track.',
      ),
    );
  }

  /** Refuses a name the migrator keeps its tables under: `migrations` and `migration_lock`. */
  #allowed(table: string, action: string): void {
    // The last segment: `public.migrations` and `main.migrations` are the same table.
    if (!isMigratorTable(lastSegment(table))) return;
    throw new SchemaError(
      withCode(
        'D4',
        `Cannot ${action} "${table}": the name belongs to the migrator, and changing it would make it lose track of which migrations ran. ` +
          'Choose another name. See docs/migrations.md#how-the-migrator-keeps-track.',
      ),
    );
  }

  /**
   * Refuses raw SQL that names a table of the migrator. Only a guard against mistakes: it reads the words of the statement, outside
   * its string literals, and does not parse it.
   */
  #rawAllowed(text: string): void {
    const words = text.replace(/'(?:[^']|'')*'/g, '').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').match(/[A-Za-z_][\w$]*/g) ?? [];
    for (const word of words) if (isMigratorTable(word)) this.#rawNames(word);
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

  /** Adds the creation of a table. */
  create(table: string, build: (table: Blueprint) => void): void {
    this.#allowed(table, 'create the table');
    const blueprint = Schema.#describe(table, build);
    if (blueprint.columns.length === 0) throw new Error(`Table "${table}" needs at least one column.`);
    if (blueprint.drops.length || blueprint.renames.length || blueprint.dropIndexes.length || blueprint.nullability.length) {
      throw new Error('dropColumn(), renameColumn(), dropIndex(), notNull() and nullable() only work when changing a table (schema.alter).');
    }
    this.#add({ kind: 'create', table, blueprint });
  }

  /**
   * Adds a change of a table. Every change runs as its own statement, because
   * SQLite's ALTER TABLE takes one change at a time. On SQLite a new NOT NULL column needs a default and cannot get a generated UUID
   * (`useUuidv7()`), and no column becomes NOT NULL or nullable (`notNull()`, `nullable()`): `migrate` refuses such a plan before running any of its steps (error D18). See `docs/migrations.md#uuid-keys` and `docs/migrations.md#changing-the-data`.
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
   * migration written earlier does.
   */
  rename(from: string, to: string, options: { readonly indexes?: boolean } = {}): void {
    this.#allowed(from, 'rename the table');
    this.#allowed(to, 'rename a table to');
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
   * Adds a statement the blueprint cannot write — one for every driver, or one per driver; a driver without a statement skips the
   * step. Marmeon does not look into it. See `docs/migrations.md#raw-sql`.
   */
  raw(statement: RawBuilder<unknown> | RawStatements): void {
    // A `RawBuilder` has `execute`; the per-driver form is a plain object.
    const statements: RawStatements = 'execute' in statement ? { sqlite: statement, pgsql: statement } : statement;
    for (const one of [statements.sqlite, statements.pgsql]) if (one) this.#rawAllowed(rawText(one.toOperationNode() as RawNode));
    this.#add({ kind: 'raw', statements });
  }
}
