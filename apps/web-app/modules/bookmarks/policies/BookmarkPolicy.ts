import { denyAsNotFound, type AuthUser } from '@marmeon/auth';

import type { Row } from '@marmeon/database';

/**
 * Only the owner of a record may act on it; everyone else gets a 404, so nobody can probe which ids exist.
 * Use it in a request: `authorize: can(BookmarkPolicy, 'update', '<param>')`. See docs/authorization.md#writing-policies.
 */
export class BookmarkPolicy {
  view(user: AuthUser, record: Row<'bookmarks'>) {
    return record.user_id === user.id || denyAsNotFound();
  }

  update(user: AuthUser, record: Row<'bookmarks'>) {
    return record.user_id === user.id || denyAsNotFound();
  }

  delete(user: AuthUser, record: Row<'bookmarks'>) {
    return record.user_id === user.id || denyAsNotFound();
  }
}
