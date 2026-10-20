import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { BookmarkRepository } from '../BookmarkRepository.ts';
import { BookmarkPolicy } from '../policies/BookmarkPolicy.ts';

export const UpdateBookmarkRequest = defineRequest({
  schema: r.object({
    title: r.string().trim().required().max(120),
  }),
  authorize: can(BookmarkPolicy, 'update', 'bookmark'),
});

/** Saves the changes to one of the user's bookmarks. */
export class UpdateBookmarkController extends Controller {
  static request = UpdateBookmarkRequest;

  readonly #bookmarks: BookmarkRepository;

  constructor(bookmarks: BookmarkRepository) {
    super();
    this.#bookmarks = bookmarks;
  }

  async handle(ctx: ContextOf<typeof UpdateBookmarkRequest>) {
    await this.#bookmarks.update(ctx.params.bookmark.id, { title: ctx.body.title });
    return this.redirect().route('bookmarks.index').flash('toast', { kind: 'success', message: 'Bookmark saved.' });
  }
}
