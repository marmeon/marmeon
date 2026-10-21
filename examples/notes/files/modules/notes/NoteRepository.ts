import { Repository, type PageRequest, type Row } from '@marmeon/database';

export class NoteRepository extends Repository<'notes'> {
  static table = 'notes' as const;

  /** One page of a user's notes: the pinned ones first, then the most recently changed. Only what the page shows. */
  pageOf(userId: Row<'notes'>['user_id'], page: PageRequest) {
    const query = this.query()
      .select(['id', 'title', 'body', 'pinned'])
      .where('user_id', '=', userId)
      .orderBy('pinned', 'desc')
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc');
    return this.paginate(query, page);
  }
}
