import type { Connections } from '../connections.ts';
import { executePlan, planOf } from '../schema/plan.ts';
import { applyPlan } from '../schema/projection.ts';
import type { Migration } from './migration.ts';

/**
 * Runs one migration's `up()` (or `down()`) on a connection, in a transaction, without the migrator's books — for tests that need
 * a table without an app, a migrator or a migrations directory. The connections learn the tables it made (their keys, secret columns
 * and marks) as a migrator would hand them over.
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
  const before = connections.projection();
  connections.publish({ ...applyPlan(before, plan, { name: 'test', module: 'test' }), migrations: before.migrations });
}
