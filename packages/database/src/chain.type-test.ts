// Type guarantees of with(), withRelation(), withCount(), whereHas() and withTrashed() — checked by `tsc` (pnpm build / typecheck), never run. The
// messages, as the compiler shows them, are quoted in the comments.
import type { Kysely } from 'kysely';
import { expectTypeOf } from 'vitest';
import './__fixtures__/relations.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import type { ModuleDatabase } from './index.ts';

declare const db: Kysely<FixtureTables>;
/** The blog module's view: its own tables, and `users` exposed by another module. */
declare const blog: ModuleDatabase<
  FixtureTables,
  { users: 'auth'; api_keys: 'auth'; posts: 'blog'; comments: 'blog'; tags: 'blog'; post_tag: 'blog'; post_stats: 'blog'; categories: 'blog'; articles: 'blog' },
  { users: true },
  'blog'
>;

export async function relationTypes() {
  // Argument of type '"autor"' is not assignable to parameter of type '"author" | "comments" | "editor" | "post_stats" | "post_tag" |
  // "post_user" | "tags" | "users"'.
  // @ts-expect-error — a relation posts does not have
  db.selectFrom('posts').with('autor');

  // No overload matches this call. The last overload gave the following error. Argument of type '"titel"' is not assignable to
  // parameter of type 'SelectExpression<FixtureTables, "comments">'.
  // @ts-expect-error — a column of another table in the relation's callback: only the related table is in scope
  db.selectFrom('posts').with('comments', (q) => q.select('titel'));

  // Argument of type '"title"' is not assignable to parameter of type 'ReferenceExpression<FixtureTables, "comments">'.
  // @ts-expect-error — the outer table is not in the callback's scope
  db.selectFrom('posts').with('comments', (q) => q.where('title', '=', 'x'));

  // Argument of type '"comments"' is not assignable to parameter of type '"api_keys" | "author" | "authored_posts" | "edited_posts" |
  // "editor" | "post_stats" | "post_tag" | "posts" | "tags" | "users"'.
  // @ts-expect-error — both joined tables have a relation "comments": not offered
  db.selectFrom('posts').innerJoin('users', 'users.id', 'posts.author_id').with('comments');

  // Argument of type '"api_keys"' is not assignable to parameter of type '"authored_posts" | "comments" | "edited_posts"'.
  // @ts-expect-error — the module does not see api_keys (owned by auth, not exposed)
  blog.selectFrom('users').with('api_keys');

  // Type '"author"' is not assignable to type '"approved" | "body" | "created_at" | "deleted_at" | "id" | "post_id" | "updated_at" | "user_id"'.
  // @ts-expect-error — withRelation's foreign key is a column of its table
  db.selectFrom('users').withRelation('mine', { table: 'comments', foreignKey: 'author' });

  // A relation the module sees, to a table another module exposes.
  const [comment] = await blog.selectFrom('comments').select('body').with('user', (q) => q.select('name')).execute();
  expectTypeOf(comment!.user).toEqualTypeOf<{ name: string } | null>();

  // Aliases, defaults, nesting and withTrashed() at every level.
  const [post] = await db
    .selectFrom('posts')
    .select('title')
    .withTrashed()
    .with('comments', { as: 'replies' }, (q) => q.withTrashed().with('user', (u) => u.select('name')))
    .with('post_stats')
    .withRelation('first_comment', { table: 'comments', foreignKey: 'post_id', one: true }, (q) => q.select('body'))
    .execute();
  expectTypeOf(post!.replies[0]!.body).toEqualTypeOf<string>();
  expectTypeOf(post!.replies[0]!.deleted_at).toEqualTypeOf<string | null>();
  expectTypeOf(post!.replies[0]!.user).toEqualTypeOf<{ name: string } | null>();
  expectTypeOf(post!.post_stats).toEqualTypeOf<{ post_id: number; views: number } | null>();
  expectTypeOf(post!.first_comment).toEqualTypeOf<{ body: string } | null>();
  // Property 'comments' does not exist on type '{ first_comment: { body: string; } | null; post_stats: …; replies: …; title: string; }'.
  // @ts-expect-error — `{ as }` renames it: there is no `comments` key
  void post!.comments;

  // Counts and filters.
  // Argument of type '"author"' is not assignable to parameter of type '"comments" | "post_tag" | "post_user" | "tags" | "users"'.
  // @ts-expect-error — author is a belongsTo: one row or none, nothing to count (whereHas asks that)
  db.selectFrom('posts').withCount('author');
  // @ts-expect-error — post_stats is a hasOne
  db.selectFrom('posts').withCount('post_stats');
  // Argument of type '"autor"' is not assignable to parameter of type '"author" | "comments" | "editor" | "post_stats" | … | "users"'.
  // @ts-expect-error — a relation posts does not have
  db.selectFrom('posts').whereHas('autor');
  // Argument of type '"title"' is not assignable to parameter of type 'ReferenceExpression<FixtureTables, "comments">'.
  // @ts-expect-error — the callback's scope is the related table
  db.selectFrom('posts').whereHas('comments', (q) => q.where('title', '=', 'x'));
  // Argument of type '"api_keys"' is not assignable to parameter of type '"authored_posts" | "comments" | "edited_posts"'.
  // @ts-expect-error — the module does not see api_keys
  blog.selectFrom('users').withCount('api_keys');
  // A belongsToMany reads its pivot: the module must see that too (post_user is not the blog module's).
  // Argument of type '"posts"' is not assignable to parameter of type '"authored_posts" | "comments" | "edited_posts"'.
  // @ts-expect-error — the pivot post_user is not visible to the module
  blog.selectFrom('users').whereHas('posts');
  // @ts-expect-error — the same for a count
  blog.selectFrom('users').withCount('posts');
  // @ts-expect-error — and for loading it
  blog.selectFrom('users').with('posts');
  const [counted] = await db
    .selectFrom('posts')
    .select('title')
    .withCount('comments')
    .withCount('tags', { as: 'labels' }, (q) => q.where('slug', '!=', 'x'))
    .whereHas('author', (q) => q.whereHas('comments'))
    .whereDoesntHave('post_stats')
    .execute();
  expectTypeOf(counted!).toEqualTypeOf<{ title: string; comments_count: number; labels: number }>();
  expectTypeOf(await blog.selectFrom('users').select('name').withCount('comments').whereHas('authored_posts').execute()).toEqualTypeOf<{ name: string; comments_count: number }[]>();

  // A secret column is not a column a relation can select — and never part of its defaults.
  const [user] = await db.selectFrom('users').select('name').with('api_keys').execute();
  expectTypeOf(user!.api_keys[0]!).toEqualTypeOf<{ id: number; user_id: number; name: string }>();
  // Kysely lets a query name a secret column (typed `never`); in a relation the connection refuses it when the query runs.
  const [named] = await db.selectFrom('users').with('api_keys', (q) => q.select('token')).execute();
  expectTypeOf(named!.api_keys[0]!.token).toEqualTypeOf<never>();
}
