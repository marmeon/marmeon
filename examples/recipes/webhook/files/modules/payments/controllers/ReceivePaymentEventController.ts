import { Clock } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Queue } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { InvoiceRepository } from '../InvoiceRepository.ts';
import { IssueReceiptJob } from '../jobs/IssueReceiptJob.ts';
import { WebhookEventRepository } from '../WebhookEventRepository.ts';

/** The signed body, checked before the controller reads it. Fields the schema does not name are left out. */
export const PaymentEventRequest = defineRequest({
  schema: r.object({
    id: r.string().min(1).max(255),
    type: r.string().max(100),
    data: r.object({ invoice: r.string().max(80).optional() }).optional(),
  }),
});

/**
 * A payment provider's event. By the time this runs `verifyWebhook('payments')` has checked the signature and the time, and the
 * schema has checked the shape of the body. The provider repeats an event until it gets a `2xx`, so the effect runs once per event id.
 */
export class ReceivePaymentEventController extends Controller {
  static request = PaymentEventRequest;

  readonly #connections: Connections;
  readonly #events: WebhookEventRepository;
  readonly #invoices: InvoiceRepository;
  readonly #queue: Queue;
  readonly #clock: Clock;

  constructor(connections: Connections, events: WebhookEventRepository, invoices: InvoiceRepository, queue: Queue, clock: Clock) {
    super();
    this.#connections = connections;
    this.#events = events;
    this.#invoices = invoices;
    this.#queue = queue;
    this.#clock = clock;
  }

  async handle(ctx: ContextOf<typeof PaymentEventRequest>) {
    const event = ctx.body;
    const reference = event.data?.invoice;
    // An event this app does not act on is acknowledged, or the sender would repeat it for days.
    if (event.type !== 'invoice.paid' || reference === undefined) return this.json({ received: true });

    // One transaction: the note of the event, the payment and the queued job all count, or none does. When anything fails, the sender's
    // next delivery finds no note and does the work again. The queued job is a row in this transaction, so a worker never sees it early.
    await this.#connections.transaction(async () => {
      const first = await this.#events.tryInsert({ event_id: event.id, type: event.type });
      if (!first.ok) return; // seen before: the unique index on `event_id` refused it
      const invoice = await this.#invoices.markPaid(reference, new Date(this.#clock.now()).toISOString());
      if (invoice) await this.#queue.dispatch(IssueReceiptJob, { invoiceId: invoice.id });
    });
    return this.json({ received: true });
  }
}
