import { Clock } from '@marmeon/core';
import type { JobContext, JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { InvoiceRepository } from '../InvoiceRepository.ts';

/** Issues the receipt of a paid invoice. The payload holds the invoice's id; the job reads the invoice as it is when it runs. */
export class IssueReceiptJob {
  /** Stable — the queue stores this name, never the class name. */
  static readonly job = 'payments.issue-receipt';
  static readonly schema = r.object({ invoiceId: r.integer() });
  static readonly tries = 3;
  static readonly backoff = [10, 60];

  readonly #invoices: InvoiceRepository;
  readonly #clock: Clock;

  constructor(invoices: InvoiceRepository, clock: Clock) {
    this.#invoices = invoices;
    this.#clock = clock;
  }

  async handle(payload: JobPayload<typeof IssueReceiptJob>, job: JobContext): Promise<void> {
    const invoice = await this.#invoices.find(payload.invoiceId);
    if (!invoice) return job.discard('the invoice is gone');
    // A job can run twice; the stamp is what keeps the second run from issuing another receipt.
    if (invoice.receipt_issued_at !== null) return;
    // The receipt itself (a PDF, a mail) goes here.
    await this.#invoices.update(invoice.id, { receipt_issued_at: new Date(this.#clock.now()).toISOString() });
  }
}
