import type { HealthCheck } from '@marmeon/core';
import { withCode, withoutCode } from '@marmeon/core/internal';
import { sql } from 'kysely';
import { Connections } from './connections.ts';
import { MigrationStateError } from './migration-state.ts';
import { SchemaRequirements, type TableRequirement } from './upgrades.ts';

/**
 * Readiness: every connection the app uses answers `select 1` — the app's pool, as requests use it (`Connections.used()`:
 * `default` and what was asked for; one nothing uses is never opened). Registered by the `DatabaseServiceProvider` for `/up/ready`.
 */
export class DatabaseHealthCheck implements HealthCheck {
  static check = 'database';

  readonly #connections: Connections;
  readonly #requirements: SchemaRequirements;

  /** @internal Apps get the check through the `DatabaseServiceProvider`. */
  constructor(connections: Connections, requirements: SchemaRequirements) {
    this.#connections = connections;
    this.#requirements = requirements;
  }

  async handle(): Promise<string> {
    const required = this.#requirements.all();
    const names = [...new Set([...this.#connections.used(), ...required.map((requirement) => requirement.connection)])];
    const failed: string[] = [];
    const errors: unknown[] = [];
    await Promise.all(
      names.map(async (name) => {
        try {
          await sql`select 1`.execute(this.#connections.get(name));
        } catch (error) {
          failed.push(name);
          errors.push(error);
        }
      }),
    );
    if (failed.length > 0) {
      const message = `The database connection${failed.length > 1 ? 's' : ''} ${failed.map((name) => `"${name}"`).join(', ')} failed: ${errors.map((error) => withoutCode(error instanceof Error ? error.message : String(error))).join('; ')}`;
      // A database that lacks migrations keeps its code: what to do about it is in the message.
      const state = errors.find((error): error is MigrationStateError => error instanceof MigrationStateError);
      throw new AggregateError(errors, state === undefined ? message : state.reason === 'pending' ? withCode('D2', message) : withCode('D1', message));
    }
    let lacking = this.#unmet(required);
    let unmarked = this.#unmarked(required);
    if (lacking.length > 0 || unmarked.length > 0) {
      // On a database another tool manages, the metadata is what this process loaded: a change elsewhere may have changed the tables since. Load again, once.
      // (What the migrations describe cannot have changed in a running process.)
      for (const connection of new Set(required.map((requirement) => requirement.connection))) {
        if (this.#connections.options(connection).managed !== false) continue;
        this.#connections.metadata(connection).invalidate();
        await sql`select 1`.execute(this.#connections.get(connection));
      }
      lacking = this.#unmet(required);
      unmarked = this.#unmarked(required);
    }
    const problems = [
      ...(lacking.length > 0 ? [`${lacking.join('; ')} — run marmeon make:upgrade-migrations, then marmeon migrate`] : []),
      ...(unmarked.length > 0 ? [`${unmarked.join('; ')} — a migration marks the column with .secret() (schema.alter), see docs/migrations.md#how-the-migrator-keeps-track`] : []),
    ];
    if (problems.length > 0) {
      const message = problems.join('. ');
      throw new Error(lacking.length > 0 ? withCode('D6', message) : message);
    }
    return names.length === 1 ? names[0]! : names.join(', ');
  }

  /** What the loaded metadata of the connections lacks of the required tables. */
  #unmet(required: readonly TableRequirement[]): string[] {
    const lacking: string[] = [];
    for (const { connection, table, columns, whenPresent } of required) {
      const { kinds } = this.#connections.metadata(connection);
      const present = kinds.get(table);
      if (present === undefined) {
        if (whenPresent) continue;
        lacking.push(`${table} is missing`);
        continue;
      }
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length > 0) lacking.push(`${table} lacks ${missing.join(', ')}`);
    }
    return lacking;
  }

  /** The columns that must be secret and are not marked so in the migrations; none on a connection that is not managed, whose migrations Marmeon does not know. */
  #unmarked(required: readonly TableRequirement[]): string[] {
    const unmarked: string[] = [];
    for (const { connection, table, secrets } of required) {
      const present = this.#connections.metadata(connection).kinds.get(table);
      if (present === undefined || this.#connections.options(connection).managed === false) continue;
      const marked = this.#connections.metadata(connection).secrets.get(table);
      const loose = (secrets ?? []).filter((column) => present.has(column) && !marked?.has(column));
      if (loose.length > 0) unmarked.push(`${table} has ${loose.join(', ')} without the secret() mark`);
    }
    return unmarked;
  }
}
