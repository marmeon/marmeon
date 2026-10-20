import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { BookmarkPolicy } from '../policies/BookmarkPolicy.ts';

export const EditBookmarkRequest = defineRequest({ authorize: can(BookmarkPolicy, 'update', 'bookmark') });

/** The form of one of the user's bookmarks — somebody else's answers 404 before this runs. */
export class EditBookmarkController extends Controller {
  static request = EditBookmarkRequest;

  handle(ctx: ContextOf<typeof EditBookmarkRequest>) {
    const { id, title } = ctx.params.bookmark;
    return this.view('bookmarks/Form', { bookmark: { id, title } });
  }
}
