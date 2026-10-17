import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { deriveRelations, introspect, type ForeignKey, type SchemaFacts } from './introspection.ts';
import { Migrator, type Connections } from './index.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'blog', migrations: fixtures('relations') },
];

const fk = (table: string, column: string, references: string, nullable = false): ForeignKey => ({ table, column, references, referenced: 'id', nullable });
const facts = (partial: Partial<SchemaFacts>): SchemaFacts => ({ foreignKeys: [], uniques: new Map(), columns: new Map(), markers: [], ...partial });
const plain = (derived: ReturnType<typeof deriveRelations>) =>
  Object.fromEntries([...derived.relations].map(([table, relations]) => [table, Object.fromEntries(relations)]));

describe('deriving relations from foreign keys', () => {
  it('names a belongsTo after the column without _id, and its inverse after the table', () => {
    const derived = deriveRelations(facts({ foreignKeys: [fk('comments', 'post_id', 'posts')] }));
    expect(derived.problems).toEqual([]);
    expect(plain(derived)).toEqual({
      comments: { post: { kind: 'belongsTo', table: 'posts', foreignKey: 'post_id', localKey: 'post_id', targetKey: 'id', nullable: false } },
      posts: { comments: { kind: 'hasMany', table: 'comments', foreignKey: 'post_id', localKey: 'id', targetKey: 'post_id' } },
    });
  });

  it('makes a one-relation nullable when the foreign key may be null or the target has soft deletes; a hasOne always', () => {
    const derived = deriveRelations(
      facts({
        foreignKeys: [fk('comments', 'user_id', 'users'), fk('comments', 'post_id', 'posts', true), fk('post_stats', 'post_id', 'posts')],
        uniques: new Map([['post_stats', [['post_id']]]]),
        markers: [{ table: 'users', column: '', marker: 'soft_deletes', value: null }],
      }),
    );
    expect(derived.relations.get('comments')?.get('user')).toMatchObject({ kind: 'belongsTo', nullable: true }); // users soft-deletes
    expect(derived.relations.get('comments')?.get('post')).toMatchObject({ kind: 'belongsTo', nullable: true }); // the FK may be NULL
    expect(derived.relations.get('post_stats')?.get('post')).toMatchObject({ kind: 'belongsTo', nullable: false });
    expect(derived.relations.get('posts')?.get('post_stats')).toEqual({ kind: 'hasOne', table: 'post_stats', foreignKey: 'post_id', localKey: 'id', targetKey: 'post_id', nullable: true });
  });

  it('takes the inverse name a migration gave the foreign key', () => {
    const derived = deriveRelations(
      facts({
        foreignKeys: [fk('posts', 'author_id', 'users'), fk('posts', 'editor_id', 'users', true)],
        markers: [
          { table: 'posts', column: 'author_id', marker: 'inverse', value: 'authored_posts' },
          { table: 'posts', column: 'editor_id', marker: 'inverse', value: 'edited_posts' },
        ],
      }),
    );
    expect(derived.problems).toEqual([]);
    expect([...derived.relations.get('posts')!.keys()]).toEqual(['author', 'editor']);
    expect([...derived.relations.get('users')!.keys()]).toEqual(['authored_posts', 'edited_posts']);
  });

  it('refuses two foreign keys to the same table without inverse names — naming them', () => {
    const derived = deriveRelations(facts({ foreignKeys: [fk('posts', 'editor_id', 'users', true), fk('posts', 'author_id', 'users')] }));
    expect(derived.problems).toEqual(["posts has two foreign keys to users (author_id, editor_id) — name the inverse relations: .inverse('…')"]);
    expect([...derived.relations.get('posts')!.keys()]).toEqual(['author', 'editor']); // the belongsTo side is clear
    expect(derived.relations.has('users')).toBe(false);
  });

  it('refuses sibling foreign keys when only some have inverse names — whichever column is named', () => {
    const message = "posts has two foreign keys to users (author_id, editor_id) — name the inverse relations: .inverse('…')";
    for (const named of ['author_id', 'editor_id']) {
      const derived = deriveRelations(
        facts({
          foreignKeys: [fk('posts', 'author_id', 'users'), fk('posts', 'editor_id', 'users', true)],
          markers: [{ table: 'posts', column: named, marker: 'inverse', value: 'x_posts' }],
        }),
      );
      expect(derived.problems).toEqual([message]);
      expect(derived.relations.has('users')).toBe(false); // no way back at all, not half of it
      expect([...derived.relations.get('posts')!.keys()]).toEqual(['author', 'editor']);
    }
  });

  it('links the two tables of a pivot (exactly two foreign keys, unique together) both ways', () => {
    const derived = deriveRelations(
      facts({ foreignKeys: [fk('post_tag', 'tag_id', 'tags'), fk('post_tag', 'post_id', 'posts')], uniques: new Map([['post_tag', [['post_id', 'tag_id']]]]) }),
    );
    expect(derived.relations.get('posts')?.get('tags')).toEqual({
      kind: 'belongsToMany', table: 'tags', pivot: 'post_tag', foreignKey: 'post_id', relatedKey: 'tag_id', localKey: 'id', targetKey: 'id',
    });
    expect(derived.relations.get('tags')?.get('posts')).toEqual({
      kind: 'belongsToMany', table: 'posts', pivot: 'post_tag', foreignKey: 'tag_id', relatedKey: 'post_id', localKey: 'id', targetKey: 'id',
    });
    // Not a pivot: unique one by one, or not unique at all.
    for (const uniques of [new Map([['post_tag', [['post_id'], ['tag_id']]]]), new Map()]) {
      const other = deriveRelations(facts({ foreignKeys: [fk('post_tag', 'tag_id', 'tags'), fk('post_tag', 'post_id', 'posts')], uniques }));
      expect(other.relations.get('posts')?.get('tags')).toBeUndefined();
    }
  });

  it('names a foreign key to its own table like any other — the way back is the table name', () => {
    const derived = deriveRelations(facts({ foreignKeys: [fk('categories', 'parent_id', 'categories', true)] }));
    expect([...derived.relations.get('categories')!]).toEqual([
      ['categories', { kind: 'hasMany', table: 'categories', foreignKey: 'parent_id', localKey: 'id', targetKey: 'parent_id' }],
      ['parent', { kind: 'belongsTo', table: 'categories', foreignKey: 'parent_id', localKey: 'parent_id', targetKey: 'id', nullable: true }],
    ]);
  });

  it('refuses a relation that would hide a column of the same name', () => {
    const derived = deriveRelations(facts({ foreignKeys: [fk('posts', 'owner', 'users')], columns: new Map([['posts', ['id', 'owner']]]) }));
    expect(derived.problems).toEqual([
      'posts.owner references users, so its relation would be named "owner" like the column — name the column owner_id',
    ]);
  });

  it('gives the same result in any input order — sorted by code point, not by locale or the database', () => {
    const keys = [fk('b', 'a_id', 'a'), fk('B', 'a_id', 'a'), fk('a', 'Z_id', 'Z'), fk('a', 'z_id', 'z'), fk('_x', 'a_id', 'a')];
    const one = deriveRelations(facts({ foreignKeys: keys }));
    const other = deriveRelations(facts({ foreignKeys: keys.toReversed() }));
    expect(JSON.stringify(plain(one))).toBe(JSON.stringify(plain(other)));
    expect([...one.relations.keys()]).toEqual(['B', 'Z', '_x', 'a', 'b', 'z']);
    expect([...one.relations.get('a')!.keys()]).toEqual(['B', 'Z', '_x', 'b', 'z']);
  });
});

describe.each(drivers)('introspecting foreign keys and unique indexes on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
  });
  afterAll(() => close());

  const run = <R>(query: string) => sql.raw<R>(query).execute(connections.get()).then((result) => result.rows);

  it('reads the same foreign keys, unique column sets and markers on every driver', async () => {
    const found = await introspect(run, driver);
    expect(found.foreignKeys).toEqual([
      { table: 'categories', column: 'parent_id', references: 'categories', referenced: 'id', nullable: true },
      { table: 'comments', column: 'post_id', references: 'posts', referenced: 'id', nullable: false },
      { table: 'comments', column: 'user_id', references: 'users', referenced: 'id', nullable: false },
      { table: 'post_stats', column: 'post_id', references: 'posts', referenced: 'id', nullable: false },
      { table: 'post_tag', column: 'post_id', references: 'posts', referenced: 'id', nullable: false },
      { table: 'post_tag', column: 'tag_id', references: 'tags', referenced: 'id', nullable: false },
      { table: 'posts', column: 'author_id', references: 'users', referenced: 'id', nullable: false },
      { table: 'posts', column: 'editor_id', references: 'users', referenced: 'id', nullable: true },
    ]);
    const uniques = Object.fromEntries([...found.uniques].filter(([table]) => !['migrations', 'marmeon_migration_lock', 'schema_markers', 'secret_columns', 'table_owners'].includes(table)));
    expect(uniques).toEqual({
      categories: [['id']],
      comments: [['id']],
      post_stats: [['post_id']],
      post_tag: [['post_id', 'tag_id']],
      posts: [['id']],
      tags: [['id'], ['slug']],
      users: [['email'], ['id']],
    });
    expect(found.markers.filter((m) => m.table !== 'users')).toEqual([
      { table: 'comments', column: '', marker: 'soft_deletes', value: null },
      { table: 'comments', column: '', marker: 'timestamps', value: null },
      { table: 'posts', column: '', marker: 'timestamps', value: null },
      { table: 'posts', column: 'author_id', marker: 'inverse', value: 'authored_posts' },
      { table: 'posts', column: 'editor_id', marker: 'inverse', value: 'edited_posts' },
    ]);
    expect(found.columns.get('post_stats')).toEqual(['post_id', 'views']);
  });

  it('leaves views out — on every driver', async () => {
    await sql`create view post_titles as select id, title from posts`.execute(connections.get());
    try {
      const found = await introspect(run, driver);
      expect(found.columns.has('post_titles')).toBe(false);
      expect(found.types.has('post_titles')).toBe(false);
    } finally {
      await sql`drop view post_titles`.execute(connections.get());
    }
  });

  it('derives the fixture’s relations from them', async () => {
    const derived = deriveRelations(await introspect(run, driver));
    expect(derived.problems).toEqual([]);
    const names = Object.fromEntries([...derived.relations].map(([table, relations]) => [table, Object.fromEntries([...relations].map(([name, r]) => [name, r.kind]))]));
    expect(names).toEqual({
      categories: { categories: 'hasMany', parent: 'belongsTo' },
      comments: { post: 'belongsTo', user: 'belongsTo' },
      post_stats: { post: 'belongsTo' },
      post_tag: { post: 'belongsTo', tag: 'belongsTo' },
      posts: { author: 'belongsTo', comments: 'hasMany', editor: 'belongsTo', post_stats: 'hasOne', post_tag: 'hasMany', tags: 'belongsToMany' },
      tags: { post_tag: 'hasMany', posts: 'belongsToMany' },
      users: { authored_posts: 'hasMany', comments: 'hasMany', edited_posts: 'hasMany' },
    });
  });
});
