// Type guarantees of pagination (W9 step 3) — checked by `tsc` (pnpm build / typecheck), never run. The messages, as the
// compiler shows them, are quoted in the comments.
import { defineRequest, type ContextOf } from '@marmeon/router';
import type { Kysely } from 'kysely';
import { rules as r } from '@marmeon/validation';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { cursorPaginate, pageQuery, paginate, type CursorEncrypter, type Paginated } from './index.ts';

declare const db: Kysely<FixtureTables>;
declare const encrypter: CursorEncrypter;

const ListUsersRequest = defineRequest({ query: r.query({ ...pageQuery({ perPage: [25, 50, 100] }), q: r.string().default('') }) });
const SearchRequest = defineRequest({ query: r.query({ q: r.string().default('') }) });

export async function paginationTypes(listed: ContextOf<typeof ListUsersRequest>, searched: ContextOf<typeof SearchRequest>) {
  const users = db.selectFrom('users').select(['id', 'name', 'born_on']);
  // The parsed query of a schema with pageQuery(): page and per_page, typed.
  const page: number = listed.query.page;
  const size: 25 | 50 | 100 = listed.query.per_page;
  const result: Paginated<{ id: number; name: string; born_on: string | null }> = await paginate(db, users, listed.query);
  await paginate(db, users, { page: 2, perPage: 10 });
  await paginate(db, users);

  // Argument of type '{ q: string; }' is not assignable to parameter of type '"this query has no page — spread pageQuery() into
  // the route's query schema: r.query({ ...pageQuery({ perPage: [25, 50] }), … }), or pass { page, perPage }"'.
  // (Without the check: "Type '{ q: string; }' has no properties in common with type 'PageRequest'.")
  // @ts-expect-error — the route's query has no page
  await paginate(db, users, searched.query);

  // Type 'string' is not assignable to type 'number'.
  // @ts-expect-error — page sizes are numbers
  pageQuery({ perPage: ['30'] });

  // A cursor is encrypted: the encrypter is not optional.
  await cursorPaginate(users, { column: 'born_on', encrypter });
  // Property 'encrypter' is missing in type '{ column: "name"; }' but required in type 'CursorOptions<"born_on" | "id" | "name">'.
  // @ts-expect-error — no encrypter
  await cursorPaginate(users, { column: 'name' });
  // Type '"email"' is not assignable to type '"born_on" | "id" | "name" | readonly ["born_on" | "id" | "name", ...("born_on" | "id" | "name")[]]'.
  // @ts-expect-error — a column the query does not select
  await cursorPaginate(users, { column: 'email', encrypter });

  return { page, size, result };
}
