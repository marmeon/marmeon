import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { GuestbookRepository } from '../GuestbookRepository.ts';

export const ListGuestbookEntriesRequest = defineRequest({
  query: r.query({ ...pageQuery({ perPage: 20 }) }),
});

/** The approved entries, twenty to a page, and the form for a new one. */
export class ListGuestbookEntriesController extends Controller {
  static request = ListGuestbookEntriesRequest;

  readonly #entries: GuestbookRepository;

  constructor(entries: GuestbookRepository) {
    super();
    this.#entries = entries;
  }

  async handle(ctx: ContextOf<typeof ListGuestbookEntriesRequest>) {
    return this.view('guestbook/ListGuestbookEntries', { entries: await this.#entries.approvedPage(ctx.query) });
  }
}
