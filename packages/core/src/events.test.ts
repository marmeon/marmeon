import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createApplication } from './application.ts';
import { ConfigError } from './config/config.ts';
import { EventFake } from './events-fake.ts';
import { EventDispatcher, EventRegistry, listen, ListenerQueue, type EventClass, type EventPayload, type QueuedListenerClass } from './events.ts';

// --- Events are plain classes; the class is their identity. `#event` makes them nominal.
class OrderPlaced {
  readonly #event = true;
  readonly orderId: string;
  constructor(orderId: string) {
    this.orderId = orderId;
  }
}
class ExpressOrderPlaced extends OrderPlaced {
  readonly #event = true;
}
class InvoiceSent {
  readonly #event = true;
  readonly invoiceId = 'inv-1';
}

// A queueable event: a stable name and the schema of what is queued of it — read from the event itself.
class OrderShipped {
  static readonly event = 'shop.order-shipped';
  static readonly schema = v.object({ orderId: v.string() });
  readonly #event = true;
  readonly orderId: string;
  readonly shippedAt = new Date();
  constructor(orderId: string) {
    this.orderId = orderId;
  }
}
class WithDate {
  static readonly event = 'shop.with-date';
  static readonly schema = v.object({ at: v.date() });
  readonly #event = true;
  readonly at = new Date();
}

// --- A service the listeners share; scoped = one per request ---------------------
export class Journal {
  readonly entries: string[] = [];
}

// Top-level classes: the injection transform derives `inject = [Journal]`.
export class SendConfirmation {
  readonly #journal: Journal;
  constructor(journal: Journal) {
    this.#journal = journal;
  }
  handle(event: OrderPlaced) {
    this.#journal.entries.push(`confirmation for ${event.orderId}`);
  }
}

export class NotifyWarehouse {
  readonly #journal: Journal;
  constructor(journal: Journal) {
    this.#journal = journal;
  }
  async handle(event: ExpressOrderPlaced) {
    await Promise.resolve();
    this.#journal.entries.push(`express pick for ${event.orderId}`);
  }
}

export class SendShippingMail {
  static readonly queue = { queue: 'mail' };
  readonly #journal: Journal;
  constructor(journal: Journal) {
    this.#journal = journal;
  }
  async handle(payload: EventPayload<typeof OrderShipped>) {
    this.#journal.entries.push(`mail for ${payload.orderId}`);
  }
}

async function app(listeners: Parameters<typeof createApplication>[0]['listeners']) {
  const application = await createApplication({ root: tmpdir(), discover: false, env: {}, listeners });
  application.container.scoped(Journal);
  return application;
}

describe('events', () => {
  it('runs class and closure listeners in order, with injected dependencies', async () => {
    const calls: string[] = [];
    const application = await app([
      listen(OrderPlaced, SendConfirmation),
      listen(OrderPlaced, (event) => void calls.push(`closure saw ${event.orderId}`)),
    ]);
    const scope = application.container.createScope();

    await scope.make(EventDispatcher).dispatch(new OrderPlaced('o-1'));

    expect(scope.make(Journal).entries).toEqual(['confirmation for o-1']);
    expect(calls).toEqual(['closure saw o-1']);
  });

  it('resolves listeners from the scope that dispatches — one journal per request', async () => {
    const application = await app([listen(OrderPlaced, SendConfirmation)]);
    const first = application.container.createScope();
    const second = application.container.createScope();

    await first.make(EventDispatcher).dispatch(new OrderPlaced('a'));
    await second.make(EventDispatcher).dispatch(new OrderPlaced('b'));

    expect(first.make(Journal).entries).toEqual(['confirmation for a']);
    expect(second.make(Journal).entries).toEqual(['confirmation for b']);
  });

  it('delivers subclass events to listeners of the base class, most specific first', async () => {
    const application = await app([listen(OrderPlaced, SendConfirmation), listen(ExpressOrderPlaced, NotifyWarehouse)]);
    const scope = application.container.createScope();

    await scope.make(EventDispatcher).dispatch(new ExpressOrderPlaced('o-2'));
    await scope.make(EventDispatcher).dispatch(new OrderPlaced('o-3'));

    expect(scope.make(Journal).entries).toEqual(['express pick for o-2', 'confirmation for o-2', 'confirmation for o-3']);
  });

  it('stops at a failing listener and propagates the error to the caller', async () => {
    const after: string[] = [];
    const application = await app([
      listen(OrderPlaced, () => {
        throw new Error('warehouse offline');
      }),
      listen(OrderPlaced, () => void after.push('ran')),
    ]);

    await expect(application.container.createScope().make(EventDispatcher).dispatch(new OrderPlaced('x'))).rejects.toThrow(
      'warehouse offline',
    );
    expect(after).toEqual([]);
  });

  it('queues a queued listener at its place in the order, with the class it was registered for', async () => {
    const queued: string[] = [];
    const order: string[] = [];
    const application = await createApplication({
      root: tmpdir(),
      discover: false,
      env: {},
      listeners: [listen(OrderShipped, () => void order.push('first')), listen(OrderShipped, SendShippingMail), listen(OrderShipped, () => void order.push('last'))],
      override: (c) =>
        c.instance(ListenerQueue, {
          queue: async (event: object, registeredFor: EventClass, listener: QueuedListenerClass) => {
            order.push('queued');
            queued.push(`${(registeredFor as unknown as { event: string }).event} → ${listener.name} (${(event as OrderShipped).orderId})`);
          },
        }),
    });
    await application.container.createScope().make(EventDispatcher).dispatch(new OrderShipped('o-9'));
    expect(order).toEqual(['first', 'queued', 'last']);
    expect(queued).toEqual(['shop.order-shipped → SendShippingMail (o-9)']);
  });

  it('fails the start when a queued listener has no queue to go to', async () => {
    const start = createApplication({ root: tmpdir(), discover: false, env: {}, listeners: [listen(OrderShipped, SendShippingMail)] });
    await expect(start).rejects.toThrow(ConfigError);
    await expect(createApplication({ root: tmpdir(), discover: false, env: {}, listeners: [listen(OrderShipped, SendShippingMail)] })).rejects.toThrow(
      'SendShippingMail is a queued listener (static queue), but this app has no queue — install and register @marmeon/queue',
    );
  });

  it('records every event in an EventFake, and holds back the listeners of the faked ones only', async () => {
    const ran: string[] = [];
    const application = await createApplication({
      root: tmpdir(),
      discover: false,
      env: {},
      listeners: [listen(OrderPlaced, (event) => void ran.push(`placed ${event.orderId}`)), listen(InvoiceSent, () => void ran.push('invoice'))],
      override: (c) => c.instance(EventFake, new EventFake(c.make(EventRegistry), [OrderPlaced])),
    });
    const events = application.container.make(EventDispatcher);
    await events.dispatch(new ExpressOrderPlaced('o-1'));
    await events.dispatch(new InvoiceSent());
    expect(ran).toEqual(['invoice']);

    const fake = application.container.make(EventFake);
    fake.assertDispatched(OrderPlaced, { orderId: 'o-1' }).assertDispatched(ExpressOrderPlaced).assertDispatchedTimes(InvoiceSent, 1);
    fake.assertNotDispatched(OrderPlaced, (event) => event.orderId === 'o-2').assertListening(InvoiceSent, application.container.make(EventRegistry).all()[1]!.listener);
    expect(() => fake.assertDispatched(OrderShipped)).toThrow('Expected OrderShipped to be dispatched. Dispatched: ExpressOrderPlaced, InvoiceSent.');
    expect(() => fake.assertNothingDispatched()).toThrow('Expected no event to be dispatched');
    expect(() => fake.assertListening(OrderPlaced, SendConfirmation)).toThrow('Expected SendConfirmation to listen to OrderPlaced. Its listeners: a closure.');
  });

  it('ignores events nobody listens to', async () => {
    const application = await app([]);
    await expect(application.container.make(EventDispatcher).dispatch(new InvoiceSent())).resolves.toBeUndefined();
  });
});

// Never called: only the types matter.
export function typeLevelTests(): void {
  // @ts-expect-error — NotifyWarehouse handles ExpressOrderPlaced, not every OrderPlaced.
  listen(OrderPlaced, NotifyWarehouse);
  // @ts-expect-error — the closure expects an InvoiceSent.
  listen(OrderPlaced, (event: InvoiceSent) => void event.invoiceId);
  // A listener for the base class may listen to the subclass:
  listen(ExpressOrderPlaced, SendConfirmation);
  // A closure's event is typed from the event class:
  listen(OrderPlaced, (event) => void event.orderId.toUpperCase());

  // Queued listeners get the event's payload — its static schema — not the event:
  listen(OrderShipped, SendShippingMail);
  class TakesTheEvent {
    static readonly queue = {};
    handle(event: OrderShipped) {
      void event.shippedAt;
    }
  }
  // @ts-expect-error — handle() of a queued listener gets the payload: EventPayload<typeof OrderShipped>.
  listen(OrderShipped, TakesTheEvent);
  // @ts-expect-error — OrderPlaced has no static event/schema: it cannot be queued.
  listen(OrderPlaced, SendShippingMail);
  class QueuedDate {
    static readonly queue = {};
    handle(payload: EventPayload<typeof WithDate>) {
      void payload.at;
    }
  }
  // @ts-expect-error — a queued event's payload is JSON: no Date.
  listen(WithDate, QueuedDate);
  // @ts-expect-error — the registry checks the same way.
  new EventRegistry().listen(OrderShipped, TakesTheEvent);
}
