import { createApplication, Logger, type Application, type ModuleDefinition, type ServiceProviderClass } from '@marmeon/core';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { silent } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import type { FailedJobStoreFactory, QueueDriverFactory } from './driver.ts';
import { MemoryFailedJobStore, MemoryQueueDriver } from './drivers/memory.ts';
import { QueueRetryCommand } from './commands/failed.ts';
import { Queue, QueueConfig, QueueServiceProvider, type JobPayload } from './index.ts';

// Drivers and failed-job stores that providers bring (`static queueDrivers`, `static failedJobDrivers`): they run jobs, see only
// what the queue stores, and every wrong name — built-in, twice, unknown — stops the start.

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

const handled: string[] = [];

class NoteJob {
  static readonly job = 'test.note';
  static readonly schema = v.object({ text: v.string(), fail: v.optional(v.boolean()) });
  handle(payload: JobPayload<typeof NoteJob>): void {
    if (payload.fail) throw new Error('refused');
    handled.push(payload.text);
  }
}

class SecretJob {
  static readonly job = 'test.secret';
  static readonly encrypted = true;
  static readonly schema = v.object({ secret: v.string() });
  handle(payload: JobPayload<typeof SecretJob>): void {
    handled.push(payload.secret);
  }
}

class SlowJob {
  static readonly job = 'test.slow';
  static readonly timeout = 120;
  static readonly schema = v.object({});
  handle(): void {}
}

/** A driver that remembers what it was pushed, over a memory queue. */
class SpyDriver extends MemoryQueueDriver {
  readonly pushed: string[] = [];
  override async push(queue: string, payload: string, delay: number): Promise<string> {
    this.pushed.push(payload);
    return super.push(queue, payload, delay);
  }
}

function pluginProvider(name: string, statics: { queueDrivers?: Record<string, QueueDriverFactory>; failedJobDrivers?: Record<string, FailedJobStoreFactory> }): ServiceProviderClass {
  const Provider = class {
    static queueDrivers = statics.queueDrivers;
    static failedJobDrivers = statics.failedJobDrivers;
  };
  Object.defineProperty(Provider, 'name', { value: name });
  return Provider as unknown as ServiceProviderClass;
}

const spy = new SpyDriver();
const failedStore = new MemoryFailedJobStore();
const memoryX: QueueDriverFactory = ({ clock }) => ({ driver: new MemoryQueueDriver({ clock }), queue: 'default', retryAfter: 90 });
const spyX: QueueDriverFactory = () => ({ driver: spy, queue: 'default', retryAfter: 90 });
const failedX: FailedJobStoreFactory = () => failedStore;

function boot(providers: ServiceProviderClass[], env: Record<string, string> = {}, modules: ModuleDefinition[] = [{ name: 'test', jobs: [NoteJob, SecretJob] }]): Promise<Application> {
  return createApplication(
    { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider, ...providers], modules },
    { env: { DB_MANAGED: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, NODE_ENV: 'test', ...env }, override: (container) => container.instance(Logger, silent) },
  );
}

describe('a queue driver of a provider', () => {
  it('runs the jobs of QUEUE_CONNECTION=<its name>, and keeps their failures in the store of QUEUE_FAILED_DRIVER', async () => {
    handled.length = 0;
    await using app = await boot([pluginProvider('MemoryPackage', { queueDrivers: { 'memory-x': memoryX }, failedJobDrivers: { 'failed-x': failedX } })], {
      QUEUE_CONNECTION: 'memory-x',
      QUEUE_FAILED_DRIVER: 'failed-x',
    });
    const queue = app.container.make(Queue);
    await queue.dispatch(NoteJob, { text: 'hello' });
    await queue.dispatch(NoteJob, { text: 'broken', fail: true });
    expect(await queue.size()).toBe(2);
    const result = await app.container.make(QueueConnections).worker('memory-x', 10).run({ queues: ['default'], stopWhenEmpty: true });
    expect(handled).toEqual(['hello']);
    expect(result.failed).toBe(1);
    expect((await failedStore.all()).map((job) => job.job)).toEqual(['test.note']);
    expect(await queue.size()).toBe(0);
  });

  it('is offered by name next to the built-in connections, and its connection options come from its factory', async () => {
    await using app = await boot([pluginProvider('MemoryPackage', { queueDrivers: { 'memory-x': memoryX } })]);
    const connections = app.container.make(QueueConnections);
    expect(connections.names()).toEqual(['sync', 'database', 'redis', 'memory-x']);
    expect(connections.options('memory-x')).toEqual({ driver: 'custom', queue: 'default', retryAfter: 90 });
  });

  it('gets the payload of an encrypted job as ciphertext — never the plaintext', async () => {
    handled.length = 0;
    spy.pushed.length = 0;
    await using app = await boot([pluginProvider('SpyPackage', { queueDrivers: { 'spy-x': spyX } })], { QUEUE_CONNECTION: 'spy-x' });
    await app.container.make(Queue).dispatch(SecretJob, { secret: 'plaintext-marker-1234' });
    expect(spy.pushed).toHaveLength(1);
    expect(spy.pushed[0]).not.toContain('plaintext-marker-1234');
    expect(JSON.parse(spy.pushed[0]!).encrypted).toBe(true);
    await app.container.make(QueueConnections).worker('spy-x', 10).run({ queues: ['default'], stopWhenEmpty: true });
    expect(handled).toEqual(['plaintext-marker-1234']);
  });

  it('holds a dispatch inside a transaction until the commit — it cannot join one, and queue.using(trx) refuses', async () => {
    const driver = new SpyDriver();
    await using app = await boot([pluginProvider('SpyPackage', { queueDrivers: { 'spy-x': () => ({ driver, queue: 'default', retryAfter: 90 }) } })], { QUEUE_CONNECTION: 'spy-x' });
    const queue = app.container.make(Queue);
    const connections = app.container.make(Connections);
    class Rollback extends Error {}
    await expect(
      connections.transaction(async () => {
        await queue.dispatch(NoteJob, { text: 'rolled back' });
        expect(driver.pushed).toHaveLength(0);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(driver.pushed).toHaveLength(0);
    await connections.transaction(async () => {
      await queue.dispatch(NoteJob, { text: 'committed' });
      expect(driver.pushed).toHaveLength(0);
    });
    expect(driver.pushed).toHaveLength(1);
    await expect(connections.transaction(async (trx) => queue.using(trx).dispatch(NoteJob, { text: 'direct' }))).rejects.toThrow(/cannot write into a database transaction/);
    expect(driver.pushed).toHaveLength(1);
  });

  it('is checked for retryAfter like a built-in one: a job that may outlast it keeps the worker from starting', async () => {
    await using app = await boot([pluginProvider('MemoryPackage', { queueDrivers: { 'memory-x': memoryX } })], { QUEUE_CONNECTION: 'memory-x' }, [{ name: 'test', jobs: [SlowJob] }]);
    expect(() => app.container.make(QueueConnections).worker('memory-x', 10)).toThrow(/test\.slow \(timeout 120s\)/);
  });
});

describe('fail closed', () => {
  it.each([0, -5, Number.NaN])('stops the start for a driver whose retryAfter is %s', async (retryAfter) => {
    const bad: QueueDriverFactory = () => ({ driver: new MemoryQueueDriver(), queue: 'default', retryAfter });
    await expect(boot([pluginProvider('BadPackage', { queueDrivers: { 'bad-x': bad } })], { QUEUE_CONNECTION: 'bad-x' })).rejects.toThrow(/retryAfter .* positive number of seconds/);
  });

  it.each(['release', 'fail', 'size', 'queues'])('stops the start for a driver without %s()', async (member) => {
    const incomplete: QueueDriverFactory = () => ({ driver: Object.assign(new MemoryQueueDriver(), { [member]: undefined }), queue: 'default', retryAfter: 90 });
    await expect(boot([pluginProvider('BadPackage', { queueDrivers: { 'bad-x': incomplete } })], { QUEUE_CONNECTION: 'bad-x' })).rejects.toThrow(/must return \{ driver, queue, retryAfter \}/);
  });

  it('stops the start for a driver that joins a transaction without being able to write through one', async () => {
    const joins: QueueDriverFactory = () => ({ driver: Object.assign(new MemoryQueueDriver(), { joinsTransaction: async () => true }), queue: 'default', retryAfter: 90 });
    await expect(boot([pluginProvider('BadPackage', { queueDrivers: { 'bad-x': joins } })], { QUEUE_CONNECTION: 'bad-x' })).rejects.toThrow(/joinsTransaction\(\) but no using/);
  });

  it('runs a factory that throws once — later lookups get the same error', async () => {
    let calls = 0;
    const throwing: QueueDriverFactory = () => {
      calls++;
      throw new Error('cannot reach the broker');
    };
    await using app = await boot([pluginProvider('BrokenPackage', { queueDrivers: { 'broken-x': throwing } })]);
    const connections = app.container.make(QueueConnections);
    expect(() => connections.options('broken-x')).toThrow('cannot reach the broker');
    expect(() => connections.driver('broken-x')).toThrow('cannot reach the broker');
    expect(calls).toBe(1);
  });

  it('stops the start for a failed-job store whose factory throws or returns half a store', async () => {
    const throwing: FailedJobStoreFactory = () => {
      throw new Error('no table');
    };
    await expect(boot([pluginProvider('P', { failedJobDrivers: { 'failed-x': throwing } })], { QUEUE_FAILED_DRIVER: 'failed-x', QUEUE_CONNECTION: 'sync' })).rejects.toThrow('no table');
    const half = (() => ({ record: async () => {}, all: async () => [], prune: async () => 0 })) as unknown as FailedJobStoreFactory;
    await expect(boot([pluginProvider('P', { failedJobDrivers: { 'failed-x': half } })], { QUEUE_FAILED_DRIVER: 'failed-x', QUEUE_CONNECTION: 'sync' })).rejects.toThrow(/must return a FailedJobStore \(record, all, find, forget, flush, prune\)/);
  });

  it('knows no custom connection from an overridden config that names no driver', async () => {
    await using app = await boot([], { QUEUE_CONNECTION: 'sync' });
    const config = app.container.make(QueueConfig);
    const connections = new QueueConnections(app.container, { ...config, connections: { ...config.connections, ghost: { driver: 'custom', queue: 'default', retryAfter: 90 } } });
    expect(() => connections.options('ghost')).toThrow(/"ghost" is not configured/);
  });

  it('queue:retry refuses a failed job of a connection that no longer exists, instead of using the default', async () => {
    const store = new MemoryFailedJobStore();
    await store.record({ uuid: 'lost', connection: 'gone', queue: 'default', job: 'test.note', payload: '{}', exception: 'x', failedAt: 1 });
    await using app = await boot([pluginProvider('MemoryPackage', { queueDrivers: { 'memory-x': memoryX }, failedJobDrivers: { 'failed-x': () => store } })], {
      QUEUE_CONNECTION: 'memory-x',
      QUEUE_FAILED_DRIVER: 'failed-x',
    });
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(`error: ${line}`), warn: () => {}, line: () => {} };
    const code = await app.container.make(QueueRetryCommand).handle({ root: '/tmp', args: ['lost'], options: {}, output } as never);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/connection "gone", which is not configured\. Known: sync, database, redis, memory-x/);
    expect(await app.container.make(Queue).size()).toBe(0);
  });

  it('stops the start for a driver that returns no driver', async () => {
    const bad = (() => ({ queue: 'default', retryAfter: 90 })) as unknown as QueueDriverFactory;
    await expect(boot([pluginProvider('BadPackage', { queueDrivers: { 'bad-x': bad } })], { QUEUE_CONNECTION: 'bad-x' })).rejects.toThrow(/must return \{ driver, queue, retryAfter \}/);
  });

  it('stops the start when QUEUE_CONNECTION names no driver, listing the known ones', async () => {
    const error = await boot([pluginProvider('MemoryPackage', { queueDrivers: { 'memory-x': memoryX } })], { QUEUE_CONNECTION: 'memry-x' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/"memry-x" is not configured\. Known: sync, database, redis, memory-x/);
  });

  it('stops the start when QUEUE_FAILED_DRIVER names no store, listing the known ones', async () => {
    const error = await boot([pluginProvider('MemoryPackage', { failedJobDrivers: { 'failed-x': failedX } })], { QUEUE_FAILED_DRIVER: 'faild-x', QUEUE_CONNECTION: 'sync' }).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/QUEUE_FAILED_DRIVER=faild-x is not a failed-job store\. Known: database, null, failed-x/);
  });

  it('stops the start for a name that is no driver name', async () => {
    await expect(boot([], { QUEUE_CONNECTION: '../x' })).rejects.toThrow(/QUEUE_CONNECTION/);
    await expect(boot([], { QUEUE_FAILED_DRIVER: 'Null' })).rejects.toThrow(/QUEUE_FAILED_DRIVER/);
  });

  it.each(['sync', 'database', 'redis'])('stops the start when a provider brings a queue driver named %s', async (name) => {
    await expect(boot([pluginProvider('Replacement', { queueDrivers: { [name]: memoryX } })])).rejects.toThrow(new RegExp(`Replacement brings a queue driver named "${name}".*built-in`));
  });

  it.each(['database', 'null'])('stops the start when a provider brings a failed-job store named %s', async (name) => {
    await expect(boot([pluginProvider('Replacement', { failedJobDrivers: { [name]: failedX } })])).rejects.toThrow(new RegExp(`Replacement brings a failed-job store named "${name}".*built-in`));
  });

  it('stops the start when two providers bring one name, even though neither is used', async () => {
    const first = pluginProvider('FirstPackage', { queueDrivers: { 'memory-x': memoryX } });
    const second = pluginProvider('SecondPackage', { queueDrivers: { 'memory-x': memoryX } });
    await expect(boot([first, second])).rejects.toThrow(/"memory-x" is brought by both FirstPackage and SecondPackage/);
    const store = (provider: string) => pluginProvider(provider, { failedJobDrivers: { 'failed-x': failedX } });
    await expect(boot([store('FirstStore'), store('SecondStore')])).rejects.toThrow(/"failed-x" is brought by both FirstStore and SecondStore/);
  });
});
