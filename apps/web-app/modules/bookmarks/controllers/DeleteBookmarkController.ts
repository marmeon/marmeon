import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { BookmarkRepository } from '../BookmarkRepository.ts';
import { BookmarkPolicy } from '../policies/BookmarkPolicy.ts';

export const DeleteBookmarkRequest = defineRequest({ authorize: can(BookmarkPolicy, 'delete', 'bookmark') });

/** Deletes one of the user's bookmarks. */
export class DeleteBookmarkController extends Controller {
  static request = DeleteBookmarkRequest;

  readonly #bookmarks: BookmarkRepository;

  constructor(bookmarks: BookmarkRepository) {
    super();
    this.#bookmarks = bookmarks;
  }

  async handle(ctx: ContextOf<typeof DeleteBookmarkRequest>) {
    await this.#bookmarks.delete(ctx.params.bookmark.id);
    return this.redirect().route('bookmarks.index').flash('toast', { kind: 'success', message: 'Bookmark deleted.' });
  }
}
