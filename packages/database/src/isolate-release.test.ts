import type { DatabaseConnection, Driver } from 'kysely';
import { describe, expect, it } from 'vitest';
import { MarmeonDriver } from './driver.ts';

/** An inner driver that only counts: nothing here runs a query. */
function countingDriver() {
  const released: DatabaseConnection[] = [];
  const connection = { executeQuery: async () => ({ rows: [] }), streamQuery: async function* () {} } as unknown as DatabaseConnection;
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async (each) => {
      released.push(each);
    },
    destroy: async () => {},
  };
  return { driver, connection, released };
}

describe('MarmeonDriver.isolate()', () => {
  it('hands the pinned connection back to the pool once: work that outlives the rollback does not release it again', async () => {
    const { driver, released } = countingDriver();
    const marmeon = new MarmeonDriver(driver, { name: 'default', driver: 'pgsql', target: 'stub' });
    const isolation = await marmeon.isolate();
    const pinned = await marmeon.acquireConnection();
    await isolation.rollback();
    expect(released).toHaveLength(1);
    await marmeon.releaseConnection(pinned);
    expect(released).toHaveLength(1);
  });

  it('releases the connection again once the pool hands it out to someone else', async () => {
    const { driver, released } = countingDriver();
    const marmeon = new MarmeonDriver(driver, { name: 'default', driver: 'pgsql', target: 'stub' });
    await (await marmeon.isolate()).rollback();
    const again = await marmeon.acquireConnection();
    await marmeon.releaseConnection(again);
    expect(released).toHaveLength(2);
  });
});
