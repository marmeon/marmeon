# A Resource With Its Policy

## Introduction

This recipe adds a record that belongs to the signed-in user, such as a bookmark, with everything around it: a table, a
repository, a policy, the routes, the controllers and their requests, two pages and a test. One command writes all of it on the
[starter kit](starter-kit.md), and the page shows the parts that decide who may see and change a record.

The code protects against three mistakes that this kind of page tends to make:

- **Reading or changing somebody else's record by its id (IDOR).** Every route that takes a bookmark from the path binds it
  through the repository and then asks `BookmarkPolicy`. The policy answers a stranger with a 404, as it does for an id that does
  not exist, so nobody can probe which ids are taken.
- **A list that shows other people's records.** The list asks the repository for `ctx.user.id` and nothing else.
- **Mass assignment of `user_id`.** A new bookmark gets its owner from the session. The controller writes `ctx.user.id` and the
  title from the body and nothing else, so a `user_id` in the form never reaches the table.

You need an app made from the starter kit, as [your first app](first-app.md) creates it. The commands use pnpm.

## Generate

```sh
pnpm marmeon make:resource Bookmark
pnpm marmeon migrate
pnpm marmeon db:types
pnpm marmeon route:types
```

`make:resource` writes the module and adds it to `modules` in `bootstrap/app.ts`. `migrate` creates the table, `db:types`
writes its columns into the app's types, and `route:types` writes the types of the new routes, so the pages and `Link` know them.
The command stops before it writes anything when `modules/bookmarks` exists or when the app lacks the auth module. Pass
`--module=<name>` to pick another module than the plural of the record. See [adding a resource](starter-kit.md#adding-a-resource).

## What it writes

| File | Purpose |
| --- | --- |
| `modules/bookmarks/index.ts` | The module: its name, its migrations and its routes. |
| `modules/bookmarks/routes.ts` | The routes behind `authenticate()` and `verified()`; the three that take a bookmark from the path bind it. |
| `modules/bookmarks/BookmarkRepository.ts` | The queries; `pageOf()` reads one page of a user's bookmarks. |
| `modules/bookmarks/migrations/<timestamp>_create_bookmarks_table.ts` | The table: a UUIDv7 key, `user_id` (deleted with the user), `title` and the timestamps. |
| `modules/bookmarks/policies/BookmarkPolicy.ts` | `view`, `update` and `delete`: only the owner, everyone else a 404. |
| `modules/bookmarks/controllers/ListBookmarksController.ts` | The signed-in user's bookmarks, ten to a page. |
| `modules/bookmarks/controllers/CreateBookmarkController.ts` | The page with the empty form. |
| `modules/bookmarks/controllers/StoreBookmarkController.ts` | Saves a new bookmark for the signed-in user. |
| `modules/bookmarks/controllers/EditBookmarkController.ts` | The page with the form filled in. |
| `modules/bookmarks/controllers/UpdateBookmarkController.ts` | Saves the changes, after the policy said yes. |
| `modules/bookmarks/controllers/DeleteBookmarkController.ts` | Deletes the bookmark, after the policy said yes. |
| `modules/bookmarks/views/ListBookmarks.tsx` | The list page, with pagination. |
| `modules/bookmarks/views/Form.tsx` | The form page, for a new bookmark and for an edit. |
| `modules/bookmarks/bookmarks.test.ts` | The tests of the module, with the stranger's bookmark on every route. |

## The code

The routes sort themselves into two groups. The list and the two routes that create a bookmark never take one from the path, so
they say `everyone`: any signed-in user. The other three bind `:bookmark` through the repository, and the request of each asks the
policy.

```ts title="modules/bookmarks/routes.ts"
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
```

The policy compares the record's owner with the user. `denyAsNotFound()` turns a refusal into a 404, which is why a missing
bookmark and somebody else's look the same.

```ts title="modules/bookmarks/policies/BookmarkPolicy.ts"
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
```

A request ties a route to the policy with `authorize: can(…)`. The third argument names the route parameter that holds the record.
The schema lists the one field the form sends, and `handle()` reads the record the router bound as `ctx.params.bookmark`:

```ts title="modules/bookmarks/controllers/UpdateBookmarkController.ts"
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
```

The store controller is where the owner comes from. It writes an object it builds field by field, and never the body as it
arrived:

```ts title="modules/bookmarks/controllers/StoreBookmarkController.ts"
  async handle(ctx: ContextOf<typeof StoreBookmarkRequest> & Authenticated) {
    await this.#bookmarks.insert({ user_id: ctx.user.id, title: ctx.body.title });
    return this.redirect().route('bookmarks.index').flash('toast', { kind: 'success', message: 'Bookmark saved.' });
  }
```

## The test

`bookmarks.test.ts` tries every route as the owner and as a stranger. This is the part for the stranger: Ada asks for Bob's
bookmark on every route that takes one from the path, and an id that does not exist gets the same answer. The test then
reads the record back, to show that nothing changed.

```ts title="modules/bookmarks/bookmarks.test.ts"
  it("answers 404 for somebody else's bookmark, however it is reached", async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const bookmark = await bookmarks().insert({ user_id: bob.id, title: 'Secret' });
    const asAda = app.actingAs(ada);
    await asAda.get(`/bookmarks/${bookmark.id}/edit`).assertNotFound();
    await asAda.put(`/bookmarks/${bookmark.id}`, { form: { title: 'Mine now' } }).assertNotFound();
    await asAda.delete(`/bookmarks/${bookmark.id}`).assertNotFound();
    await asAda.get('/bookmarks/no-such-id/edit').assertNotFound();
    expect(await bookmarks().find(bookmark.id)).toMatchObject({ title: 'Secret' });
  });
```

Run the module's tests:

```sh
pnpm test modules/bookmarks
```

The other tests of the file cover a guest, the list that shows only the owner's bookmarks, a `user_id` in the form that changes
nothing, the title rules, and the deletion of the bookmarks together with their user. See [HTTP tests](http-tests.md) for the helpers.

## Check

```sh
pnpm marmeon check
pnpm marmeon route:list
```

`marmeon check` runs the type check and the lint, and then boots the app. A route that does not say who may call it does not boot,
so a route you add to `routes.ts` without a policy or `everyone` fails the `boot` check. `raw-sql` warns when you sort the list by
a value from the request with `sql.raw(input)`; the [check](check.md#raw-sql) page shows the fix. `throttle` warns about a route that
anyone may call to change something and nothing limits. `route:list` prints the `ACCESS` column of each route: `everyone` for the list and the two
routes that create, `can BookmarkPolicy.update(bookmark)` for edit and update, and `can BookmarkPolicy.delete(bookmark)` for destroy.

To add a field, write a second migration with `pnpm marmeon make:migration add_url_to_bookmarks_table --module=bookmarks`. Then
add the field in every place that names fields one by one: the schemas of `StoreBookmarkRequest` and `UpdateBookmarkRequest`, the
object that `StoreBookmarkController` writes and the one that `UpdateBookmarkController` writes, the props that
`EditBookmarkController` passes to the form (it hands on only `{ id, title }`), the form, and the `select` of the repository's
`pageOf()`. Writing the fields one by one is what protects against mass assignment: a field you do not name never reaches the
table, so do not replace those objects with `ctx.body`, and keep `user_id` out of both schemas. The
[migrations](migrations.md#generating-migrations) page shows how to write the change, and [validation](validation.md) the rules
for the field.

## Where to go next

- [Authorization](authorization.md) for policies, the gate and the abilities your pages can read.
- [Adding a resource](starter-kit.md#adding-a-resource) for what the generator promises.
- [Routing](routing.md#route-model-binding) for binding a record by its repository.
- [Checking an app](check.md) for every check, and how to silence a finding with a reason.
