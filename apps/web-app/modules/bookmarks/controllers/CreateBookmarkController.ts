import { Controller } from '@marmeon/http';

/** The empty form of a new bookmark. */
export class CreateBookmarkController extends Controller {
  handle() {
    return this.view('bookmarks/Form', { bookmark: null });
  }
}
