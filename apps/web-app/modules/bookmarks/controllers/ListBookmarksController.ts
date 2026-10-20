import type { Authenticated } from '@marmeon/auth';
import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { BookmarkRepository } from '../BookmarkRepository.ts';

export const ListBookmarksRequest = defineRequest({
  query: r.query({ ...pageQuery({ perPage: 10 }) }),
});

/** The signed-in user's bookmarks, ten to a page. */
export class ListBookmarksController extends Controller {
  static request = ListBookmarksRequest;

  readonly #bookmarks: BookmarkRepository;

  constructor(bookmarks: BookmarkRepository) {
    super();
    this.#bookmarks = bookmarks;
  }

  async handle(ctx: ContextOf<typeof ListBookmarksRequest> & Authenticated) {
    return this.view('bookmarks/ListBookmarks', { bookmarks: await this.#bookmarks.pageOf(ctx.user.id, ctx.query) });
  }
}
