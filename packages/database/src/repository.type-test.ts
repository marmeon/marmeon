// Type guarantees of a repository's finders and relation writes — checked by `tsc` (pnpm build / typecheck), never run. The messages,
// as the compiler shows them, are quoted in the comments.
import { defineRoutes } from '@marmeon/router';
import { expectTypeOf } from 'vitest';
import './__fixtures__/relations.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Repository, type ModuleTables } from './index.ts';

class Posts extends Repository<'posts', FixtureTables> {
  static table = 'posts' as const;
}
class Keys extends Repository<'api_keys', FixtureTables> {
  static table = 'api_keys' as const;
}

/** The blog module's view: its own tables, and `users` exposed by another module — readable, never writable. */
type Blog = ModuleTables<
  FixtureTables,
  { users: 'auth'; api_keys: 'auth'; post_user: 'readers'; posts: 'blog'; comments: 'blog'; tags: 'blog'; post_tag: 'blog'; post_stats: 'blog'; categories: 'blog'; articles: 'blog' },
  { users: true; post_user: true },
  'blog'
>;
class BlogUsers extends Repository<'users', Blog> {
  static table = 'users' as const;
}
class BlogPosts extends Repository<'posts', Blog> {
  static table = 'posts' as const;
}

declare const posts: Posts;
declare const keys: Keys;
declare const blogUsers: BlogUsers;
declare const blogPosts: BlogPosts;
declare const removed: number[] | undefined;

export async function finderTypes() {
  expectTypeOf(await posts.findBy('title', 'First')).toEqualTypeOf<Awaited<ReturnType<Posts['find']>>>();
  // Argument of type '"titel"' is not assignable to parameter of type '"author_id" | "created_at" | "editor_id" | "featured" | "id" |
  // "published_at" | "rating" | "title" | "updated_at"'.
  // @ts-expect-error — not a column of posts
  void posts.findBy('titel', 'First');
  // Argument of type 'number' is not assignable to parameter of type 'string'.
  // @ts-expect-error — the value has the column's type
  void posts.findBy('title', 1);
  // Argument of type '"token"' is not assignable to parameter of type '"id" | "name" | "user_id"'.
  // @ts-expect-error — a secret column is not a column a finder reads or compares
  void keys.findBy('token', 'x');
  // Argument of type '"token"' is not assignable to parameter of type '"id" | "name" | "user_id"'.
  // @ts-expect-error — nor one pluck() reads (refused when it runs, too)
  void keys.pluck('token');
  expectTypeOf(await keys.pluck('name')).toEqualTypeOf<string[]>();

  expectTypeOf(await posts.firstWhere({ author_id: 1, featured: true })).toEqualTypeOf<Awaited<ReturnType<Posts['find']>>>();
  // Object literal may only specify known properties, but 'autor_id' does not exist in type 'Exact<Partial<{ author_id: number; …; }>, { …; }>'.
  // Did you mean to write 'author_id'?
  // @ts-expect-error — not a column of posts
  void posts.firstWhere({ autor_id: 1 });

  const post = await posts.findOrFail(1, { with: ['author', 'tags'] });
  expectTypeOf(post.tags).toEqualTypeOf<{ id: number; slug: string }[]>();
  expectTypeOf(post.title).toEqualTypeOf<string>();
  // Type '"autor"' is not assignable to type '"author" | "comments" | "editor" | "post_stats" | "post_tag" | "post_user" | "tags" | "users"'.
  // Did you mean '"author"'?
  // @ts-expect-error — a relation posts does not have
  void posts.findOrFail(1, { with: ['autor'] });

  for await (const batch of posts.chunk(100, (query) => query.where('featured', '=', true).withCount('comments'))) {
    expectTypeOf(batch[0]!.comments_count).toEqualTypeOf<number>();
    expectTypeOf(batch[0]!.title).toEqualTypeOf<string>();
  }
}

export function routeBindingTypes() {
  defineRoutes((Route) => {
    Route.bind('post', Posts, { with: ['author', 'tags'] }).get('/posts/:post', (ctx) => {
      expectTypeOf(ctx.params.post.tags).toEqualTypeOf<{ id: number; slug: string }[]>();
      expectTypeOf(ctx.params.post.author?.name).toEqualTypeOf<string | undefined>();
      expectTypeOf(ctx.params.post.title).toEqualTypeOf<string>();
      // Property 'comments' does not exist on type '{ author: { balance: string; …; } | null; ... 9 more ...; updated_at: string; }'.
      // @ts-expect-error — not named, not loaded
      void ctx.params.post.comments;
      return null;
    });
    // Without relations, the row as it is.
    Route.bind('post', Posts).get('/posts/:post', (ctx) => {
      expectTypeOf(ctx.params.post).toEqualTypeOf<NonNullable<Awaited<ReturnType<Posts['find']>>>>();
      return null;
    });
    // Type '"autor"' is not assignable to type '"author" | "comments" | "editor" | "post_stats" | "post_tag" | "post_user" | "tags" | "users"'.
    // Did you mean '"author"'?
    // @ts-expect-error — a relation posts does not have
    Route.bind('post', Posts, { with: ['autor'] });
  });
}

export async function relationWriteTypes() {
  const { attached, detached } = await posts.relation(1, 'tags').sync([1, 2]);
  expectTypeOf(attached).toEqualTypeOf<number[]>();
  expectTypeOf(detached).toEqualTypeOf<number[]>();
  // Type 'string' is not assignable to type 'number'.
  // @ts-expect-error — a tag's key is a number
  void posts.relation(1, 'tags').sync(['1']);
  await posts.relation(1, 'tags').detach();
  // Argument of type 'number[] | undefined' is not assignable to parameter of type 'number | readonly number[]'.
  //   Type 'undefined' is not assignable to type 'number | readonly number[]'.
  // @ts-expect-error — ids that may be undefined: detach() without an argument is the one that unlinks every link
  void posts.relation(1, 'tags').detach(removed);

  const comment = await posts.relation(1, 'comments').create({ user_id: 2, body: 'hello' });
  expectTypeOf(comment.post_id).toEqualTypeOf<number>();
  await posts.relation(1, 'comments').createMany([{ user_id: 2, body: 'one', approved: true }, { user_id: 2, body: 'two' }]);
  // Type 'number' is not assignable to type 'never'.
  // @ts-expect-error — the relation sets the foreign key: it is not among the values
  void posts.relation(1, 'comments').create({ user_id: 2, body: 'hello', post_id: 3 });
  // Argument of type '{ user_id: number; }' is not assignable to parameter of type 'Exact<NewRelated<FixtureTables, "comments", "post_id">, …>'.
  //   Property 'body' is missing in type '{ user_id: number; }' but required in type 'NewRelated<FixtureTables, "comments", "post_id">'.
  // @ts-expect-error — the other required columns are
  void posts.relation(1, 'comments').create({ user_id: 2 });
  // Property 'sync' does not exist on type 'RelatedWriter<FixtureTables, "comments", "post_id">'.
  // @ts-expect-error — a hasMany has rows, not links
  void posts.relation(1, 'comments').sync([1]);
  // Property 'create' does not exist on type 'LinkWriter<number>'.
  // @ts-expect-error — a belongsToMany has links, not rows of its own
  void posts.relation(1, 'tags').create({ slug: 'x' });
  // Argument of type '"author"' is not assignable to parameter of type '"comments" | "post_stats" | "post_tag" | "post_user" | "tags" | "users"'.
  // @ts-expect-error — a belongsTo is written with an update of its foreign key
  void posts.relation(1, 'author');

  // A module writes only into its own tables: its posts' comments and tags, not another module's users or their links.
  await blogPosts.relation(1, 'comments').create({ user_id: 2, body: 'hello' });
  await blogPosts.relation(1, 'tags').attach(1);
  // Argument of type '"users"' is not assignable to parameter of type '"comments" | "post_stats" | "post_tag" | "tags"'.
  // @ts-expect-error — the pivot post_user belongs to the readers module
  void blogPosts.relation(1, 'users');
  // Argument of type '"api_keys"' is not assignable to parameter of type '"authored_posts" | "comments" | "edited_posts"'.
  // @ts-expect-error — api_keys is the auth module's, and not even exposed
  void blogUsers.relation(1, 'api_keys');
}
