import type { Row } from '@marmeon/database';
import type { RouteBinder } from '@marmeon/http';
import { GuestbookRepository } from './GuestbookRepository.ts';

/** `/guestbook/:entry` — an approved entry by its id. An entry nobody approved is a 404, like an id that does not exist. */
export class ApprovedEntries implements RouteBinder<Row<'guestbook_entries'>> {
  readonly #entries: GuestbookRepository;

  constructor(entries: GuestbookRepository) {
    this.#entries = entries;
  }

  async resolveRouteBinding(id: string) {
    const entry = await this.#entries.findByRouteKey(id);
    return entry?.approved_at ? entry : undefined;
  }
}
