import { Repository, type PageRequest } from '@marmeon/database';

export class GuestbookRepository extends Repository<'guestbook_entries'> {
  static table = 'guestbook_entries' as const;

  /** One page of the approved entries, the newest first. Only what the page shows. */
  approvedPage(page: PageRequest) {
    const query = this.query()
      .select(['id', 'name', 'message', 'created_at'])
      .where('approved_at', 'is not', null)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
    return this.paginate(query, page);
  }
}
