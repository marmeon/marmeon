import { Repository, type Row } from '@marmeon/database';

export class InvoiceRepository extends Repository<'invoices'> {
  static table = 'invoices' as const;

  /** Marks the invoice with this reference as paid; the invoice, or `undefined` when there is none or it was paid already. */
  async markPaid(reference: string, paidAt: string): Promise<Row<'invoices'> | undefined> {
    // One statement: the condition `paid_at is null` sits in the UPDATE, so two events for one invoice cannot both pass a check
    // before either writes. Reading first and updating after would let both of them queue a receipt.
    return this.db.updateTable('invoices').set({ paid_at: paidAt, updated_at: paidAt }).where('reference', '=', reference).where('paid_at', 'is', null).returningAll().executeTakeFirst();
  }
}
