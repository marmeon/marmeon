import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { GuestbookRepository } from '../GuestbookRepository.ts';

export const StoreGuestbookEntryRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().max(60),
    message: r.string().trim().required().max(500),
  }),
});

/** Saves an entry that nobody has approved yet. Every valid form gets the same answer. */
export class StoreGuestbookEntryController extends Controller {
  static request = StoreGuestbookEntryRequest;

  readonly #entries: GuestbookRepository;

  constructor(entries: GuestbookRepository) {
    super();
    this.#entries = entries;
  }

  async handle(ctx: ContextOf<typeof StoreGuestbookEntryRequest>) {
    await this.#entries.insert({ name: ctx.body.name, message: ctx.body.message });
    return this.redirect().route('guestbook.index').flash('toast', { kind: 'success', message: 'Thank you. Your entry appears once it has been approved.' });
  }
}
