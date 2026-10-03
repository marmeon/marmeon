import { Clock, createApplication, EventDispatcher, inTransaction, listen, Logger, TestClock, type Application, type EventPayload, type ModuleDefinition } from '@bespokecore/core';
import { Connections, DatabaseServiceProvider, sql } from '@bespokecore/database';
import { EncryptionServiceProvider } from '@bespokecore/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import { JobQueued } from './events.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueServiceProvider, RECORD_OPTIONS } from './index.ts';
import { QueueSetupError } from './registry.ts';

// Queued listeners (E86): `static queue` on a listener class — the dispatcher queues a `bespoke.listener` job with the
// event's payload (its `static schema`), a worker runs the listener with it.

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

/** Into the transaction itself (a database queue joins it). */
export class UpdateWarehouse {
  static readonly queue = { afterCommit: false };
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
    env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY },
    providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider],
    modules: [{ name: 'shop', listeners: options.listeners ?? [listen(OrderShipped, SendShippingMail), listen(OrderShipped, UpdateWarehouse)] }],
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
  (await sql<{ queue: string; payload: string }>`select queue, payload from jobs order by id`.execute(application.container.make(Connections).get())).rows;

describe('queued listeners (E86)', () => {
  it('are queued as an encrypted bespoke.listener job with the event payload — and a worker runs them in a scope of their own', async () => {
    await using application = await app();
    await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-77'));

    const rows = await jobRows(application);
    expect(rows.map((row) => row.queue)).toEqual(['mail', 'default']);
    const record = JSON.parse(rows[0]!.payload) as { job: string; encrypted: boolean; data: unknown; tries: number; backoff: number[] };
    expect(record).toMatchObject({ job: 'bespoke.listener', encrypted: true, tries: 3, backoff: [10, 60] }); // the listener's settings
    expect(rows.map((row) => row.payload).join()).not.toContain('order-77'); // E105: no plaintext payload
    expect(application.seen.entries).toEqual([]);

    const result = await application.container.make(QueueConnections).worker('database', 10).run({ queues: ['*'], stopWhenEmpty: true });
    expect(result).toMatchObject({ processed: 2, failed: 0 });
    expect(application.seen.entries.map(({ listener, payload, inTransaction }) => ({ listener, payload, inTransaction }))).toEqual([
      { listener: 'UpdateWarehouse', payload: { orderId: 'order-77' }, inTransaction: false },
      { listener: 'SendShippingMail', payload: { orderId: 'order-77' }, inTransaction: false }, // only what the schema reads — not the customer
    ]);
  });

  it('wait for the commit by default (afterCommit) — afterCommit: false writes the job into the transaction; a rollback drops both', async () => {
    await using application = await app();
    const connections = application.container.make(Connections);
    const inside: string[][] = [];
    await connections.transaction(async () => {
      await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-1'));
      inside.push((await jobRows(application)).map((row) => row.queue));
    });
    expect(inside).toEqual([['default']]); // only UpdateWarehouse (afterCommit: false) is part of the transaction
    expect((await jobRows(application)).map((row) => row.queue).sort()).toEqual(['default', 'mail']);

    await sql`delete from jobs`.execute(connections.get());
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
      'Expected the queued listener SendShippingMail to be queued with a matching payload. Queued listeners: SendShippingMail, UpdateWarehouse.',
    );
    expect(queue.pending().map((entry) => entry.payload).join()).not.toContain('order-5'); // encrypted in the fake's queue too

    expect(await queue.work()).toMatchObject({ processed: 2, failed: 0 });
    expect(application.seen.entries.map((entry) => entry.payload)).toEqual([{ orderId: 'order-5' }, { orderId: 'order-5' }]);
    expect(application.seen.entries.find((entry) => entry.listener === 'SendShippingMail')!.unit).toMatch(/^[0-9a-f-]{36}$/); // built in the job's scope
  });

  it('fail a queued run at once when the payload no longer matches the event schema (a deploy changed it), and retry an unknown listener by its tries', async () => {
    await using application = await app({ fake: true });
    const queue = application.container.make(Queue) as QueueFake;
    const { CallQueuedListener } = await import('./listeners.ts');
    // Three tries: a mismatch must not use them up — it never will match.
    await queue.dispatch(CallQueuedListener as never, { event: 'shop.order-shipped', listener: 'SendShippingMail', payload: { orderId: 7 } } as never, { [RECORD_OPTIONS]: { tries: 3 } } as never);
    await queue.dispatch(CallQueuedListener as never, { event: 'shop.order-shipped', listener: 'RenamedListener', payload: { orderId: 'x' } } as never);
    expect(await queue.work()).toMatchObject({ failed: 2, released: 0 });
    const failed = await queue.failed();
    expect(failed.map((entry) => entry.exception).join('\n')).toContain('The payload no longer matches the schema of the event shop.order-shipped (SendShippingMail): orderId:');
    expect(failed.map((entry) => entry.exception).join('\n')).toContain('No queued listener RenamedListener of the event shop.order-shipped in this app — was it renamed or removed?');
    expect(application.seen.entries).toEqual([]);
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
      static readonly queue = { queue: 'mail' };
      handle(): void {}
    }
    class BadTries {
      static readonly queue = { tries: 0 };
      handle(): void {}
    }
    class Typo {
      static readonly queue = { aftercommit: false };
      handle(): void {}
    }
    const fails = (listeners: ModuleDefinition['listeners']) => app({ listeners });
    await expect(fails([listen(JobQueued, Listens as never)])).rejects.toThrow(
      /Listens is a queued listener \(static queue\) of JobQueued, which cannot be queued: give JobQueued static event = 'module.what-happened'.*Job events \(JobQueued …\) never can/,
    );
    await expect(fails([listen(NoSchema, Listens as never)])).rejects.toThrow('NoSchema (shop.no-schema) has a queued listener (Listens) and needs static schema');
    await expect(fails([listen(OrderShipped, Listens as never), listen(Twin, Listens as never)])).rejects.toThrow('Two events are named "shop.order-shipped": OrderShipped and Twin.');
    await expect(fails([listen(OrderShipped, BadTries as never)])).rejects.toThrow(QueueSetupError);
    await expect(fails([listen(OrderShipped, Typo as never)])).rejects.toThrow('Typo (static queue): unknown setting "aftercommit"');
  });
});

// Never called: only the types matter.
export function typeLevelTests(): void {
  listen(OrderShipped, SendShippingMail);
  class OnJobQueued {
    static readonly queue = {};
    handle(_event: JobQueued): void {}
  }
  // @ts-expect-error — job events cannot be queued (no static event/schema): a queued listener of one would loop.
  listen(JobQueued, OnJobQueued);
}
