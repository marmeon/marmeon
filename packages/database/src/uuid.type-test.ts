// Type guarantees of the UUID columns — checked by `tsc` (pnpm build / typecheck), never run.
import type { Kysely } from 'kysely';
import { defineMigration, type Generated } from './index.ts';

/** What `marmeon db:types` writes for the tables of the two patterns. */
interface Tables {
  teams: { id: Generated<string>; name: string };
  profiles: { id: Generated<number>; public_id: Generated<string>; name: string };
}
declare const db: Kysely<Tables>;

export async function uuidTypes() {
  await db.insertInto('teams').values({ name: 'Ada' }).execute();
  await db.insertInto('profiles').values({ name: 'Ada' }).execute();
  await db.insertInto('teams').values({ id: '0190a000-0000-7000-8000-000000000001', name: 'Ada' }).execute();

  // @ts-expect-error — a UUID primary key is a string
  await db.insertInto('teams').values({ id: 1, name: 'Ada' }).execute();
  // @ts-expect-error — the public key is a string as well
  await db.insertInto('profiles').values({ public_id: 1, name: 'Ada' }).execute();
}

defineMigration({
  up: (schema) =>
    schema.create('memberships', (table) => {
      table.uuidId();
      table.foreignUuid('team_id').constrained().cascadeOnDelete();
      table.uuid('public_id').unique().useUuidv7();
      // @ts-expect-error — only a uuid column defaults to a UUIDv7
      table.string('slug').useUuidv7();
      // @ts-expect-error — only a uuid column defaults to a UUIDv7, a foreign key does not
      table.foreignUuid('owner_id').useUuidv7();
      // @ts-expect-error — on-delete rules need a reference first
      table.foreignUuid('editor_id').cascadeOnDelete();
    }),
});
