import { readdirSync, readFileSync } from 'node:fs';
import { Clock, createApplication, EventDispatcher, inTransaction, listen, Logger, type Application, type EventPayload, type ModuleDefinition } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import { JobQueued } from './events.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueServiceProvider } from './index.ts';
import { RECORD_OPTIONS } from './queue.ts';
import { QueueSetupError } from './registry.ts';

// Queued listeners: `static queue` on a listener class — the dispatcher queues a `marmeon.listener` job with the
// event's payload (its `static schema`), a worker runs the listener with it.

const FORMATS = new URL('./__fixtures__/formats/', import.meta.url);
const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

class Seen {
  readonly entries: { listener: string; payload: unknown; inTransaction: boolean; unit: string }[] = [];
}
/** Scoped: one per job attempt. */
class UnitOfWork {
  readonly id = crypto.randomUUID();
}

class OrderShipped {
  static readonly event = 'shop.order-shipped';
  static readonly schema = v.object({ orderId: v.string() });
  readonly #event = true;
  readonly orderId: string;
  readonly customer: { readonly name: string };
  constructor(orderId: string) {
    this.orderId = orderId;
    this.customer = { name: 'Ada' };
  }
}

export class SendShippingMail {
  static readonly listener = 'shop.send-shipping-mail';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };
  readonly #seen: Seen;
  readonly #unit: UnitOfWork;
  constructor(seen: Seen, unit: UnitOfWork) {
    this.#seen = seen;
    this.#unit = unit;
  }
  async handle(payload: EventPayload<typeof OrderShipped>): Promise<void> {
    this.#seen.entries.push({ listener: 'SendShippingMail', payload, inTransaction: inTransaction(), unit: this.#unit.id });
  }
}

/** On the default queue. */
export class UpdateWarehouse {
  static readonly listener = 'shop.update-warehouse';
  static readonly queue = {};
  readonly #seen: Seen;
  constructor(seen: Seen) {
    this.#seen = seen;
  }
  handle(payload: EventPayload<typeof OrderShipped>): void {
    this.#seen.entries.push({ listener: 'UpdateWarehouse', payload, inTransaction: inTransaction(), unit: '' });
  }
}

async function app(options: { listeners?: ModuleDefinition['listeners']; fake?: boolean } = {}): Promise<Application & { seen: Seen }> {
  const seen = new Seen();
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider],
    modules: [{ name: 'shop', listeners: options.listeners ?? [listen(OrderShipped, SendShippingMail), listen(OrderShipped, UpdateWarehouse)] }],
  }, {
    env: { DB_MANAGED: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, NODE_ENV: 'test' },
    override: (container) => {
      container.instance(Clock, new TestClock());
      container.instance(Seen, seen);
      container.scoped(UnitOfWork);
      container.instance(Logger, silent);
      if (options.fake) container.instance(Queue, new QueueFake(container));
    },
  });
  await migrate(application.container.make(Connections));
  return Object.assign(application, { seen });
}

const jobRows = async (application: Application) =>
  (await sql<{ queue: string; payload: string }>`select queue, payload from marmeon_jobs order by id`.execute(application.container.make(Connections).get())).rows;

describe('queued listeners', () => {
  it('are queued as an encrypted marmeon.listener job with the event payload — and a worker runs them in a scope of their own', async () => {
    await using application = await app();
    await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-77'));

    const rows = await jobRows(application);
    expect(rows.map((row) => row.queue)).toEqual(['mail', 'default']);
    const record = JSON.parse(rows[0]!.payload) as { job: string; encrypted: boolean; data: unknown; tries: number; backoff: number[] };
    expect(record).toMatchObject({ job: 'marmeon.listener', encrypted: true, tries: 3, backoff: [10, 60] }); // the listener's settings
    expect(rows.map((row) => row.payload).join()).not.toContain('order-77'); // no plaintext payload
    expect(application.seen.entries).toEqual([]);

    // A worker on every queue: the job queued first runs first — the mail, then the default queue's.
    const result = await application.container.make(QueueConnections).worker('database', 10).run({ stopWhenEmpty: true });
    expect(result).toMatchObject({ processed: 2, failed: 0 });
    expect(application.seen.entries.map(({ listener, payload, inTransaction }) => ({ listener, payload, inTransaction }))).toEqual([
      { listener: 'SendShippingMail', payload: { orderId: 'order-77' }, inTransaction: false }, // only what the schema reads — not the customer
      { listener: 'UpdateWarehouse', payload: { orderId: 'order-77' }, inTransaction: false },
    ]);
  });

  it('are part of the transaction around the dispatch: the job rows are written inside it — atomic with the data — and a rollback drops them', async () => {
    await using application = await app();
    const connections = application.container.make(Connections);
    const inside: string[][] = [];
    await connections.transaction(async () => {
      await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-1'));
      inside.push((await jobRows(application)).map((row) => row.queue));
    });
    // Both jobs exist inside the transaction (never written after the commit: a crash in between would lose them).
    expect(inside.map((queues) => [...queues].sort())).toEqual([['default', 'mail']]);
    expect((await jobRows(application)).map((row) => row.queue).sort()).toEqual(['default', 'mail']);

    await sql`delete from marmeon_jobs`.execute(connections.get());
    await expect(
      connections.transaction(async () => {
        await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-2'));
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await jobRows(application)).toEqual([]);
  });

  it('show up in the QueueFake (assertListenerQueued) — and app.queue.work() runs them for real', async () => {
    await using application = await app({ fake: true });
    await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-5'));
    const queue = application.container.make(Queue) as QueueFake;
    queue.assertListenerQueued(SendShippingMail, { orderId: 'order-5' }).assertListenerQueued(UpdateWarehouse).assertListenerNotQueued(SendShippingMail, { orderId: 'other' });
    expect(queue.listenerQueued(SendShippingMail).map((entry) => entry.dispatched.queue)).toEqual(['mail']);
    expect(() => queue.assertListenerQueued(SendShippingMail, { orderId: 'other' })).toThrow(
      'Expected the queued listener shop.send-shipping-mail to be queued with a matching payload. Queued listeners: shop.send-shipping-mail, shop.update-warehouse.',
    );
    expect(queue.pending().map((entry) => entry.payload).join()).not.toContain('order-5'); // encrypted in the fake's queue too

    expect(await queue.work()).toMatchObject({ processed: 2, failed: 0 });
    expect(application.seen.entries.map((entry) => entry.payload)).toEqual([{ orderId: 'order-5' }, { orderId: 'order-5' }]);
    expect(application.seen.entries.find((entry) => entry.listener === 'SendShippingMail')!.unit).toMatch(/^[0-9a-f-]{36}$/); // built in the job's scope
  });

  it('match a queued listener in the QueueFake by the class, not by its name: a subclass inheriting the name is another listener', async () => {
    class Sub extends SendShippingMail {}
    await using application = await app({ fake: true });
    await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-6'));
    const queue = application.container.make(Queue) as QueueFake;
    queue.assertListenerQueued(SendShippingMail);
    expect(queue.listenerQueued(Sub as never)).toEqual([]);
    queue.assertListenerNotQueued(Sub as never);
  });

  it('fail a queued run at once when the payload no longer matches the event schema (a deploy changed it)', async () => {
    await using application = await app({ fake: true });
    const queue = application.container.make(Queue) as QueueFake;
    const { CallQueuedListener } = await import('./listeners.ts');
    // Three tries: a mismatch must not use them up — it never will match.
    await queue.dispatch(CallQueuedListener as never, { event: 'shop.order-shipped', listener: 'shop.send-shipping-mail', payload: { orderId: 7 } } as never, { [RECORD_OPTIONS]: { tries: 3 } } as never);
    expect(await queue.work()).toMatchObject({ failed: 1, released: 0 });
    const failed = await queue.failed();
    expect(failed.map((entry) => entry.exception).join('\n')).toContain('The payload no longer matches the schema of the event shop.order-shipped (shop.send-shipping-mail): orderId:');
    expect(application.seen.entries).toEqual([]);
  });

  it('hold a job naming a listener this app does not have — the class name, as the former release wrote it, included — and run no other listener', async () => {
    await using application = await app({ fake: true });
    const queue = application.container.make(Queue) as QueueFake;
    const { CallQueuedListener } = await import('./listeners.ts');
    for (const listener of ['SendShippingMail', 'shop.renamed-listener']) {
      await queue.dispatch(CallQueuedListener as never, { event: 'shop.order-shipped', listener, payload: { orderId: 'x' } } as never);
    }
    expect(await queue.work()).toMatchObject({ failed: 0, released: 2 });
    expect(application.seen.entries).toEqual([]);
  });

  it('are found by their static listener: renaming the class changes nothing', async () => {
    class Renamed {
      static readonly listener = 'shop.send-shipping-mail';
      static readonly queue = {};
      readonly #seen: Seen;
      constructor(seen: Seen) {
        this.#seen = seen;
      }
      handle(payload: EventPayload<typeof OrderShipped>): void {
        this.#seen.entries.push({ listener: 'Renamed', payload, inTransaction: false, unit: '' });
      }
    }
    await using application = await app({ listeners: [listen(OrderShipped, Renamed)] });
    await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-9'));
    expect(JSON.parse((await jobRows(application))[0]!.payload)).toMatchObject({ job: 'marmeon.listener', encrypted: true });
    expect(await application.container.make(QueueConnections).worker('database', 10).run({ stopWhenEmpty: true })).toMatchObject({ processed: 1, failed: 0 });
    expect(application.seen.entries.map((entry) => entry.listener)).toEqual(['Renamed']);
  });

  it('read every fixture of the stored job a queued listener leaves', async () => {
    const files = readdirSync(new URL('queued-listener/', FORMATS));
    expect(files).toContain('v1.json');
    for (const name of files) {
      await using application = await app();
      const text = readFileSync(new URL(`queued-listener/${name}`, FORMATS), 'utf8');
      await sql`insert into marmeon_jobs (queue, payload, attempts, available_at, created_at) values ('default', ${text}, 0, 0, 0)`.execute(application.container.make(Connections).get());
      expect(await application.container.make(QueueConnections).worker('database', 10).run({ stopWhenEmpty: true }), name).toMatchObject({ processed: 1, failed: 0 });
      expect(application.seen.entries.map((entry) => entry.payload), name).toEqual([{ orderId: 'order-77' }]);
    }
  });

  it('refuse an event their schema rejects — at the dispatch, in the dispatching code', async () => {
    await using application = await app({ fake: true });
    const broken = new OrderShipped('x');
    Object.defineProperty(broken, 'orderId', { value: 42 });
    await expect(application.container.createScope().make(EventDispatcher).dispatch(broken)).rejects.toThrow(
      'OrderShipped cannot be queued for SendShippingMail: its static schema rejects the event — orderId: Invalid type: Expected string but received 42',
    );
  });

  it('fail the start when the event cannot be queued, names collide or static queue is wrong', async () => {
    class NoSchema {
      static readonly event = 'shop.no-schema';
      readonly #event = true;
    }
    class Twin {
      static readonly event = 'shop.order-shipped';
      static readonly schema = v.object({});
      readonly #event = true;
    }
    class Listens {
      static readonly listener = 'shop.listens';
      static readonly queue = { queue: 'mail' };
      handle(): void {}
    }
    class BadTries {
      static readonly listener = 'shop.badtries';
      static readonly queue = { tries: 0 };
      handle(): void {}
    }
    class Typo {
      static readonly listener = 'shop.typo';
      static readonly queue = { aftercommit: false };
      handle(): void {}
    }
    class StillAfterCommit {
      static readonly listener = 'shop.stillaftercommit';
      static readonly queue = { afterCommit: true };
      handle(): void {}
    }
    class Unnamed {
      static readonly queue = {};
      handle(): void {}
    }
    class Shouting {
      static readonly listener = 'Shop.Shouting';
      static readonly queue = {};
      handle(): void {}
    }
    class Twin2 {
      static readonly listener = 'shop.listens';
      static readonly queue = {};
      handle(): void {}
    }
    const fails = (listeners: ModuleDefinition['listeners']) => app({ listeners });
    await expect(fails([listen(JobQueued, Listens as never)])).rejects.toThrow(
      /Listens is a queued listener \(static queue\) of JobQueued, which cannot be queued: give JobQueued static event = 'module.what-happened'.*Job events \(JobQueued …\) never can/,
    );
    await expect(fails([listen(NoSchema, Listens as never)])).rejects.toThrow('NoSchema (shop.no-schema) has a queued listener (Listens) and needs static schema');
    await expect(fails([listen(OrderShipped, Listens as never), listen(Twin, Listens as never)])).rejects.toThrow('Two events are named "shop.order-shipped": OrderShipped and Twin.');
    await expect(fails([listen(OrderShipped, Unnamed as never)])).rejects.toThrow(
      "Unnamed (static queue) needs static listener — the stable name its queued jobs carry, never the class name (a rename or a minifier changes that): static listener = '<module>.unnamed'.",
    );
    await expect(fails([listen(OrderShipped, Shouting as never)])).rejects.toThrow('Shouting (static queue): "Shop.Shouting" is not a name like');
    await expect(fails([listen(OrderShipped, Listens as never), listen(OrderShipped, Twin2 as never)])).rejects.toThrow(
      'Listens and Twin2, both queued listeners of OrderShipped, have the same static listener "shop.listens".',
    );
    await expect(fails([listen(OrderShipped, BadTries as never)])).rejects.toThrow(QueueSetupError);
    await expect(fails([listen(OrderShipped, Typo as never)])).rejects.toThrow('Typo (static queue): unknown setting "aftercommit"');
    await expect(fails([listen(OrderShipped, StillAfterCommit as never)])).rejects.toThrow(
      'StillAfterCommit (static queue): afterCommit is always on: queued listeners join the transaction — remove it.',
    );
  });
});

// Never called: only the types matter.
export function typeLevelTests(): void {
  listen(OrderShipped, SendShippingMail);
  class OnJobQueued {
    static readonly listener = 'shop.on-job-queued';
    static readonly queue = {};
    handle(_event: JobQueued): void {}
  }
  // @ts-expect-error — job events cannot be queued (no static event/schema): a queued listener of one would loop.
  listen(JobQueued, OnJobQueued);
  class WithAfterCommit {
    static readonly listener = 'shop.with-after-commit';
    static readonly queue = { queue: 'mail', afterCommit: false };
    handle(_payload: EventPayload<typeof OrderShipped>): void {}
  }
  // @ts-expect-error — no afterCommit option: queued listeners always join the transaction.
  listen(OrderShipped, WithAfterCommit);
}
