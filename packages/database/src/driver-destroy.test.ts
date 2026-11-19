import type { DatabaseConnection, Driver } from 'kysely';
import { describe, expect, it } from 'vitest';
import { MarmeonDriver } from './driver.ts';

/** An inner driver that only counts what the wrapper passes on. */
function fake(options: { failDestroy?: number } = {}) {
  const calls = { init: 0, destroy: 0 };
  let failures = options.failDestroy ?? 0;
  const driver: Driver = {
    init: async () => {
      calls.init += 1;
    },
    acquireConnection: async () => ({ executeQuery: async () => ({ rows: [] }), streamQuery: async function* () {} }) as unknown as DatabaseConnection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {
      calls.destroy += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error('close failed');
      }
    },
  };
  return { driver: new MarmeonDriver(driver, { name: 'default', driver: 'pgsql', target: 'stub' }), calls };
}

describe('MarmeonDriver.destroy()', () => {
  it('passes nothing on for a driver that never initialised, and refuses a later init() without initialising the inner one', async () => {
    const { driver, calls } = fake();
    await driver.destroy();
    await expect(driver.init()).rejects.toThrow('The database connections are closed (the application shut down); cannot use "default".');
    await expect(driver.isolate()).rejects.toThrow('cannot use "default"');
    expect(calls).toEqual({ init: 0, destroy: 0 });
  });

  it('closes the inner driver once, however often it is called', async () => {
    const { driver, calls } = fake();
    await driver.init();
    await Promise.all([driver.destroy(), driver.destroy()]);
    await driver.destroy();
    expect(calls.destroy).toBe(1);
  });

  it('tries again after a close that failed, and stays closed to init()', async () => {
    const { driver, calls } = fake({ failDestroy: 1 });
    await driver.init();
    await expect(driver.destroy()).rejects.toThrow('close failed');
    await expect(driver.init()).rejects.toThrow('cannot use "default"');
    await driver.destroy();
    expect(calls.destroy).toBe(2);
  });

  /** An inner driver whose `init` waits for the test, and which records the order of `init` ending and `destroy` running. */
  function slow() {
    const events: string[] = [];
    let settle!: (failure?: Error) => void;
    const started = new Promise<void>((resolve, reject) => {
      settle = (failure) => (failure ? reject(failure) : resolve());
    });
    const driver = {
      init: async () => {
        await started.finally(() => events.push('init ended'));
      },
      destroy: async () => {
        events.push('destroy');
      },
    } as unknown as Driver;
    return { driver: new MarmeonDriver(driver, { name: 'default', driver: 'pgsql', target: 'stub' }), events, settle };
  }

  it('waits for an init that is still running before it closes the inner driver', async () => {
    const { driver, events, settle } = slow();
    const initialising = driver.init();
    const closing = driver.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
    settle();
    await Promise.all([initialising, closing]);
    expect(events).toEqual(['init ended', 'destroy']);
  });

  it('resolves when the init it waited for failed', async () => {
    const { driver, events, settle } = slow();
    const initialising = driver.init();
    const failed = expect(initialising).rejects.toThrow('no server');
    const closing = driver.destroy();
    settle(new Error('no server'));
    await failed;
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual(['init ended', 'destroy']);
  });

  it('refuses with the shutdown message a request that waited for the lock of a single connection, and releases the lock', async () => {
    const inner = { init: async () => {}, acquireConnection: async () => ({ executeQuery: async () => ({ rows: [] }), streamQuery: async function* () {} }) as unknown as DatabaseConnection, releaseConnection: async () => {}, destroy: async () => {} } as unknown as Driver;
    const driver = new MarmeonDriver(inner, { name: 'default', driver: 'sqlite', target: 'stub' }, { single: true });
    await driver.init();
    const first = await driver.acquireConnection();
    const waiting = driver.acquireConnection();
    const refused = expect(waiting).rejects.toThrow('The database connections are closed (the application shut down); cannot use "default".');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await driver.destroy();
    await driver.releaseConnection(first);
    await refused;
  }, 5000);
});
