import { Repository, type PageRequest, type Row } from '@marmeon/database';

export class BookmarkRepository extends Repository<'bookmarks'> {
  static table = 'bookmarks' as const;

  /** One page of a user's bookmarks, the most recently changed first. Only what the page shows. */
  pageOf(userId: Row<'bookmarks'>['user_id'], page: PageRequest) {
    const query = this.query()
      .select(['id', 'title'])
      .where('user_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc');
    return this.paginate(query, page);
  }
}
