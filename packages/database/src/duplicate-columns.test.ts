import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql, type Generated } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshConnections } from './__fixtures__/databases.ts';
import { Migrator, Repository, type Connections } from './index.ts';

interface Tables {
  tenant_members: { id: Generated<number>; tenant_id: number; email: string };
}

class MemberRepository extends Repository<'tenant_members', Tables> {
  static table = 'tenant_members' as const;
}

const modules: ModuleDefinition[] = [{ name: 'tenancy', migrations: new URL('./__fixtures__/migrations/tenancy/', import.meta.url) }];

// Postgres leaves the `Key (…)=(…)` detail out of the error for a role that row-level security holds back: only the
// constraint's name is left, and the columns come from the migrations.
describe.runIf(process.env.MARMEON_TEST_PGSQL_URL)("the columns of a duplicate without the driver's detail — on pgsql", () => {
  const role = `marmeon_rls_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections('pgsql'));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
  });
  afterAll(async () => {
    const db = connections.get();
    await sql`drop owned by ${sql.id(role)}`.execute(db).catch(() => undefined);
    await sql`drop role if exists ${sql.id(role)}`.execute(db);
    await close();
  });

  it('tryInsert() and tryUpdate() name the columns of the index from its name', async () => {
    const db = connections.get();
    await sql`create role ${sql.id(role)}`.execute(db);
    await sql`grant select, insert, update on tenant_members to ${sql.id(role)}`.execute(db);
    await sql`alter table tenant_members enable row level security`.execute(db);
    await sql`create policy everything on tenant_members to ${sql.id(role)} using (true) with check (true)`.execute(db);
    const members = new MemberRepository(connections);
    await members.insert({ tenant_id: 1, email: 'ada@example.com' });
    const other = await members.insert({ tenant_id: 2, email: 'ada@example.com' });
    // The error itself: no detail, only the constraint.
    const raw = await db
      .transaction()
      .execute(async (trx) => {
        await sql`set local role ${sql.id(role)}`.execute(trx);
        await sql`insert into tenant_members (tenant_id, email) values (1, 'ada@example.com')`.execute(trx);
      })
      .catch((error: unknown) => error);
    expect((raw as { detail?: string }).detail).toBeUndefined();
    expect((raw as { constraint?: string }).constraint).toBe('tenant_members_tenant_id_email_unique');
    await db.transaction().execute(async (trx) => {
      await sql`set local role ${sql.id(role)}`.execute(trx);
      const bound = members.using(trx);
      expect(await bound.tryInsert({ tenant_id: 1, email: 'ada@example.com' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['tenant_id', 'email'] } });
      expect(await bound.tryUpdate(other.id as never, { tenant_id: 1 })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['tenant_id', 'email'] } });
    });
  });

  it('an index of raw SQL is read from its name, the longest column first: tenant_id, not tenant_id and id', async () => {
    const db = connections.get();
    await sql`create unique index tenant_members_one_per_tenant_id_unique on tenant_members (tenant_id) where email like 'solo%'`.execute(db);
    const members = new MemberRepository(connections);
    await members.insert({ tenant_id: 9, email: 'solo-1' });
    await db.transaction().execute(async (trx) => {
      await sql`set local role ${sql.id(role)}`.execute(trx);
      expect(await members.using(trx).tryInsert({ tenant_id: 9, email: 'solo-2' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['tenant_id'] } });
    });
  });
});
