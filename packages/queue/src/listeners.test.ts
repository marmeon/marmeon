import { Clock, createApplication, EventDispatcher, inTransaction, listen, Logger, TestClock, type Application, type EventPayload, type ModuleDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import { JobQueued } from './events.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueServiceProvider, RECORD_OPTIONS } from './index.ts';
import { QueueSetupError } from './registry.ts';

// Queued listeners (E86): `static queue` on a listener class — the dispatcher queues a `marmeon.listener` job with the
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

/** On the default queue. */
export class UpdateWarehouse {
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
  it('are queued as an encrypted marmeon.listener job with the event payload — and a worker runs them in a scope of their own', async () => {
    await using application = await app();
    await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('order-77'));

    const rows = await jobRows(application);
    expect(rows.map((row) => row.queue)).toEqual(['mail', 'default']);
    const record = JSON.parse(rows[0]!.payload) as { job: string; encrypted: boolean; data: unknown; tries: number; backoff: number[] };
    expect(record).toMatchObject({ job: 'marmeon.listener', encrypted: true, tries: 3, backoff: [10, 60] }); // the listener's settings
    expect(rows.map((row) => row.payload).join()).not.toContain('order-77'); // E105: no plaintext payload
    expect(application.seen.entries).toEqual([]);

    // A worker on every queue (E199): the job queued first runs first — the mail, then the default queue's.
    const result = await application.container.make(QueueConnections).worker('database', 10).run({ stopWhenEmpty: true });
    expect(result).toMatchObject({ processed: 2, failed: 0 });
    expect(application.seen.entries.map(({ listener, payload, inTransaction }) => ({ listener, payload, inTransaction }))).toEqual([
      { listener: 'SendShippingMail', payload: { orderId: 'order-77' }, inTransaction: false }, // only what the schema reads — not the customer
      { listener: 'UpdateWarehouse', payload: { orderId: 'order-77' }, inTransaction: false },
    ]);
  });

  it('are part of the transaction around the dispatch (E107, E109): the job rows are written inside it — atomic with the data — and a rollback drops them', async () => {
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
    class StillAfterCommit {
      static readonly queue = { afterCommit: true };
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
    await expect(fails([listen(OrderShipped, StillAfterCommit as never)])).rejects.toThrow(
      'StillAfterCommit (static queue): afterCommit is always on: queued listeners join the transaction — remove it.',
    );
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
  class WithAfterCommit {
    static readonly queue = { queue: 'mail', afterCommit: false };
    handle(_payload: EventPayload<typeof OrderShipped>): void {}
  }
  // @ts-expect-error — afterCommit is gone (E109): queued listeners always join the transaction.
  listen(OrderShipped, WithAfterCommit);
}
