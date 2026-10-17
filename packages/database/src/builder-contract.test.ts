import { CommonTableExpressionNameNode, CommonTableExpressionNode, CreateTableNode, SelectQueryNode, WithNode, Kysely, QueryCreator, RawNode, sql, TableNode, type Compilable, type RootOperationNode } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { SchemaMetadata } from './metadata.ts';
import { RelationsPlugin } from './relations.ts';
import { SchemaResolver } from './schema-resolver.ts';
import { guardSecrets, rootKind } from './secret-guard.ts';
import { READ_METHODS, WRITE_METHODS, type ModuleDatabase } from './types.ts';

// What a module's database offers is decided here, method by method: a method Kysely adds is neither one nor the other until someone
// reads what it does.

/** Every method (and getter) a class has, up its prototype chain to `Object.prototype`. */
function methodsOf(type: { readonly prototype: object }): string[] {
  const names = new Set<string>();
  for (let prototype: object | null = type.prototype; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of Object.getOwnPropertyNames(prototype)) if (name !== 'constructor') names.add(name);
  }
  return [...names].sort();
}

interface Tables {
  posts: { id: number; title: string };
  users: { id: number; name: string };
}
declare const blog: ModuleDatabase<Tables, { posts: 'blog'; users: 'auth' }, { users: true }, 'blog'>;

const classified = (name: string): number => [READ_METHODS, WRITE_METHODS].filter((list) => (list as readonly string[]).includes(name)).length;

describe('the builder a module gets', () => {
  it.each([
    ['Kysely', Kysely],
    ['QueryCreator', QueryCreator],
  ] as const)('classifies every method of %s as reading or writing', (name, type) => {
    const unclassified = methodsOf(type).filter((method) => classified(method) !== 1);
    expect(unclassified, `${name} has methods that are in no list or in both — classify it in types.ts: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('classifies no method Kysely does not have', () => {
    const known = new Set([...methodsOf(Kysely), ...methodsOf(QueryCreator)]);
    expect([...READ_METHODS, ...WRITE_METHODS].filter((method) => !known.has(method))).toEqual([]);
  });

  it('knows every method at the type level too', () => {
    type Unclassified = Exclude<Extract<keyof Kysely<{}>, string>, (typeof READ_METHODS)[number] | (typeof WRITE_METHODS)[number]>;
    expectTypeOf<Unclassified>().toEqualTypeOf<never>();
  });

  // Bodies are only compiled: `declare const` has no value.
  it('offers no way to write, run raw SQL, change the schema or reach beyond the module', () => void (() => {
    blog.selectFrom('posts').selectAll();
    blog.insertInto('posts');
    // @ts-expect-error — another module's table cannot be written, even though it can be read
    blog.insertInto('users');
    // @ts-expect-error — DDL
    void blog.schema.dropTable('posts');
    // @ts-expect-error — raw execution of a compiled query
    void blog.executeQuery({} as Compilable);
    // @ts-expect-error — `sql\`…\`.execute(db)` goes through the executor, and would write anywhere
    void blog.getExecutor();
    // @ts-expect-error — lists the tables of other modules that are not exposed
    void blog.introspection;
    // @ts-expect-error — closes the connection every module shares
    void blog.destroy();
    // @ts-expect-error — hands back a database without the module's boundaries
    void blog.$extendTables<{ other: { id: number } }>();
    // @ts-expect-error — hands back a database without the module's boundaries
    void blog.$pickTables<'users'>();
    // @ts-expect-error — a common table expression may be an insert … returning
    void blog.with('t', (db) => db.selectFrom('posts').selectAll());
    // @ts-expect-error — not a write the boundaries know
    void blog.replaceInto('users');
    // @ts-expect-error — not a write the boundaries know
    void blog.mergeInto('users');
    // @ts-expect-error — an own table cannot be declared again with `withTables`
    void blog.withTables<{ other: { id: number }; posts: { id: number } }>();
    // @ts-expect-error — `sql\`…\`.execute(db)` must not compile either
    void sql`select 1`.execute(blog);
  }));
});

describe('a statement kind the secret guard does not know', () => {
  const future = { kind: 'FutureQueryNode' } as unknown as RootOperationNode;

  it('is refused by the guard, not scanned for what it might hold', () => {
    expect(() => guardSecrets(future, new SchemaMetadata('sqlite'))).toThrow('The secret guard does not know the statement FutureQueryNode');
  });

  it('is refused by the schema resolver while the schema is not loaded', () => {
    const metadata = new SchemaMetadata('sqlite');
    const resolver = new SchemaResolver(metadata, {} as never, new RelationsPlugin('sqlite', metadata));
    expect(() => resolver.transformQuery({ node: future, queryId: {} as never })).toThrow('The secret guard does not know the statement FutureQueryNode');
  });

  it('is refused by the schema resolver once the schema is loaded, before anything else looks at it', () => {
    const metadata = { fresh: true } as unknown as SchemaMetadata;
    const resolver = new SchemaResolver(metadata, {} as never, new RelationsPlugin('sqlite', metadata));
    expect(() => resolver.transformQuery({ node: future, queryId: {} as never })).toThrow('The secret guard does not know the statement FutureQueryNode');
  });

  it('is refused as the body of a common table expression', () => {
    const select = {
      ...SelectQueryNode.createFrom([TableNode.create('t')]),
      with: WithNode.create(CommonTableExpressionNode.create(CommonTableExpressionNameNode.create('t'), future as never)),
    };
    expect(() => guardSecrets(select, new SchemaMetadata('sqlite'))).toThrow('The secret guard does not know the statement FutureQueryNode');
  });

  it('is refused when it is named like something every object has', () => {
    for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) { expect(() => rootKind({ kind })).toThrow('does not know the statement'); expect(() => rootKind({ kind })).toThrow(/^\[marmeon:D10\] /); }
  });

  it('is no reason to refuse the kinds it does know', () => {
    const metadata = new SchemaMetadata('sqlite');
    expect(() => guardSecrets(RawNode.createWithSql('select 1'), metadata)).not.toThrow();
    expect(() => guardSecrets(CreateTableNode.create(TableNode.create('things')), metadata)).not.toThrow();
  });
});
