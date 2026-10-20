import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { CreateBookmarkController } from './controllers/CreateBookmarkController.ts';
import { DeleteBookmarkController } from './controllers/DeleteBookmarkController.ts';
import { EditBookmarkController } from './controllers/EditBookmarkController.ts';
import { ListBookmarksController } from './controllers/ListBookmarksController.ts';
import { StoreBookmarkController } from './controllers/StoreBookmarkController.ts';
import { UpdateBookmarkController } from './controllers/UpdateBookmarkController.ts';
import { BookmarkRepository } from './BookmarkRepository.ts';

// Signed in, with a confirmed address. A bookmark in the URL is looked up by its id and then checked
// against the signed-in user by BookmarkPolicy: somebody else's bookmark is a 404.
export default defineRoutes((Route) => {
  const bookmarks = Route.prefix('/bookmarks').middleware(authenticate()).middleware(verified()).name('bookmarks.');

  // These three never take a bookmark from the path: the list asks for `ctx.user.id`, and a new bookmark is created for the signed-in user.
  const mine = bookmarks.authorize(everyone);
  mine.get('/', ListBookmarksController).name('index');
  mine.get('/create', CreateBookmarkController).name('create');
  mine.post('/', StoreBookmarkController).name('store');

  const bookmark = bookmarks.bind('bookmark', BookmarkRepository);
  bookmark.get('/:bookmark/edit', EditBookmarkController).name('edit');
  bookmark.put('/:bookmark', UpdateBookmarkController).name('update');
  bookmark.delete('/:bookmark', DeleteBookmarkController).name('destroy');
});
