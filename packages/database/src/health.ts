import type { HealthCheck } from '@marmeon/core';
import { sql } from 'kysely';
import { Connections } from './connections.ts';

/**
 * Readiness: every connection the app uses answers `select 1` — the app's pool, as requests use it (`Connections.used()`:
 * `default` and what was asked for; one nothing uses is never opened). Registered by the `DatabaseServiceProvider` for `/up/ready`.
 */
export class DatabaseHealthCheck implements HealthCheck {
  static check = 'database';

  readonly #connections: Connections;

  constructor(connections: Connections) {
    this.#connections = connections;
  }

  async handle(): Promise<string> {
    const names = this.#connections.used();
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
    if (failed.length > 0) throw new AggregateError(errors, `The database connection${failed.length > 1 ? 's' : ''} ${failed.map((name) => `"${name}"`).join(', ')} failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`);
    return names.length === 1 ? names[0]! : names.join(', ');
  }
}
