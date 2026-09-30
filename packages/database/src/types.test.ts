import { ConsoleLogger, type Container } from '@bespokecore/core';
import type { Generated, Kysely } from 'kysely';
import * as v from 'valibot';
import { expectTypeOf, it } from 'vitest';
import { Connections, Database, defineConnection, type QueryEvent, type Tables } from './index.ts';

// Type guarantees of step 1 — checked by the compiler (`pnpm typecheck`); the test body only runs trivially.
interface Shop {
  orders: { id: Generated<number>; total: number };
}

it('types connections, configuration and the query log', () => {
  const connections = new Connections({ connections: {}, root: '/', logger: new ConsoleLogger() });
  const shop = () => connections.get<Shop>('shop');
  expectTypeOf(shop).returns.toEqualTypeOf<Kysely<Shop>>();
  // @ts-expect-error — (1) unknown table
  void (() => shop().selectFrom('customers'));
  // @ts-expect-error — (2) wrong column type on insert
  void (() => shop().insertInto('orders').values({ total: '12' }));

  // The default connection is typed by the (generated) `Tables`.
  expectTypeOf<Database>().toEqualTypeOf<Kysely<Tables>>();
  const fromContainer = (container: Container) => container.make(Database);
  expectTypeOf(fromContainer).returns.toEqualTypeOf<Kysely<Tables>>();

  defineConnection('reporting', { env: v.object({ URL: v.string() }), resolve: (env) => ({ driver: 'pgsql', url: env.URL }) });
  // @ts-expect-error — (3) unknown driver
  defineConnection('a', { env: v.object({}), resolve: () => ({ driver: 'mysql', url: 'x' }) });
  // @ts-expect-error — (4) SQLite needs a database file
  defineConnection('b', { env: v.object({}), resolve: () => ({ driver: 'sqlite' }) });
  // @ts-expect-error — (5) env is typed by the schema
  defineConnection('c', { env: v.object({ URL: v.string() }), resolve: (env) => ({ driver: 'pgsql', url: env.DB_URL }) });

  connections.onQuery((query) => {
    expectTypeOf(query).toEqualTypeOf<QueryEvent>();
    // @ts-expect-error — (6) events are read-only
    query.sql = 'changed';
  });
});
