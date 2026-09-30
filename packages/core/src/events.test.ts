import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createApplication } from './application.ts';
import { EventDispatcher, listen } from './events.ts';

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
}
