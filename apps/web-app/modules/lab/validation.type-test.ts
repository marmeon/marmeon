/**
 * Type guarantees of the `where` of `unique()` and `exists()` with the repositories' own query — checked by `tsc`
 * (`pnpm typecheck`), never run.
 */
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import type { HttpContext } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { UserRepository } from '#modules/auth';
import { BookmarkRepository } from '../bookmarks/BookmarkRepository.ts';

type BookmarkContext = HttpContext<Authenticated, { bookmark: Row<'bookmarks'> }>;

r.integer().exists(BookmarkRepository, 'id', { where: (query) => query.where('user_id', '=', 1) }); // fine
r.string().unique(UserRepository, 'email', { where: (query) => query.where('email', '=', 'ada@example.test') }); // fine
r.integer().exists(BookmarkRepository, 'id', { where: (query, ctx: BookmarkContext) => query.where('user_id', '=', ctx.params.bookmark.user_id) }); // fine

// @ts-expect-error — a column the table does not have
r.integer().exists(BookmarkRepository, 'id', { where: (query) => query.where('wrong_column', '=', 1) });

// @ts-expect-error — a value of another type than the column's
r.integer().exists(BookmarkRepository, 'id', { where: (query) => query.where('user_id', '=', 'one') });

// @ts-expect-error — a callback that does not return the query
r.integer().exists(BookmarkRepository, 'id', { where: () => 'nothing' });

// @ts-expect-error — a callback without `return`
r.integer().exists(BookmarkRepository, 'id', { where: (query) => { query.where('user_id', '=', 1); } });

// @ts-expect-error — an `async` callback returns a promise, not the query
r.integer().exists(BookmarkRepository, 'id', { where: async (query) => query.where('user_id', '=', 1) });

// @ts-expect-error — a typo in an annotated ctx
r.integer().exists(BookmarkRepository, 'id', { where: (query, ctx: BookmarkContext) => query.where('user_id', '=', ctx.params.bookmrk.user_id) });
