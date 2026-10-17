import type { Connections } from '../connections.ts';
import { executePlan, planOf } from '../schema/plan.ts';
import type { Migration } from './migration.ts';

/**
 * Runs one migration's `up()` (or `down()`) on a connection, in a transaction, without the migrator's books — for tests that need
 * a table without an app, a migrator or a migrations directory.
 * @internal
 */
export async function runMigration(
  connections: Connections,
  migration: Pick<Migration, 'up' | 'down'>,
  options: { readonly connection?: string; readonly direction?: 'up' | 'down' } = {},
): Promise<void> {
  const name = options.connection ?? 'default';
  const plan = planOf(migration, options.direction ?? 'up');
  await connections
    .get(name)
    .transaction()
    .execute((trx) => executePlan(trx, connections.options(name).driver, plan));
}
