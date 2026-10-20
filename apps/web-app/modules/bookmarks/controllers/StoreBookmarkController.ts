import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { BookmarkRepository } from '../BookmarkRepository.ts';

// What the form sends: a title. Nothing else — the owner is the signed-in user, never a field.
export const StoreBookmarkRequest = defineRequest({
  schema: r.object({
    title: r.string().trim().required().max(120),
  }),
});

/** Saves a new bookmark for the signed-in user. */
export class StoreBookmarkController extends Controller {
  static request = StoreBookmarkRequest;

  readonly #bookmarks: BookmarkRepository;

  constructor(bookmarks: BookmarkRepository) {
    super();
    this.#bookmarks = bookmarks;
  }

  async handle(ctx: ContextOf<typeof StoreBookmarkRequest> & Authenticated) {
    await this.#bookmarks.insert({ user_id: ctx.user.id, title: ctx.body.title });
    return this.redirect().route('bookmarks.index').flash('toast', { kind: 'success', message: 'Bookmark saved.' });
  }
}
