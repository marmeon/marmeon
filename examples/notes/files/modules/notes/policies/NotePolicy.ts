import { denyAsNotFound, type AuthUser } from '@marmeon/auth';
import type { Row } from '@marmeon/database';

/**
 * A note belongs to the person who wrote it. Anyone else gets the answer of a note that does not exist, so nobody can
 * probe the ids of other people's notes.
 */
export class NotePolicy {
  update(user: AuthUser, note: Row<'notes'>) {
    return note.user_id === user.id || denyAsNotFound();
  }

  delete(user: AuthUser, note: Row<'notes'>) {
    return note.user_id === user.id || denyAsNotFound();
  }
}
