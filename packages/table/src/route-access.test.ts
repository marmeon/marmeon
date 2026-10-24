import { defineRoutes, everyone, Router } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { Deactivate } from './__fixtures__/app.ts';
import { MemberPolicy } from './__fixtures__/policies.ts';
import { action, column, defineTable, exportCsv, tableRoutes, type DataTable } from './index.ts';

const table = (options: { authorized: boolean }): DataTable =>
  defineTable({
    name: 'rows',
    query: ((db: { selectFrom(name: string): unknown }) => db.selectFrom('members')) as never,
    key: 'members.id',
    columns: { name: column('members.name').sortable() },
    actions: { deactivate: options.authorized ? action(Deactivate).authorize(MemberPolicy, 'deactivate') : action(Deactivate) },
    export: { csv: options.authorized ? exportCsv().authorize(() => true) : exportCsv() },
  } as never);

const load = (decide: (Root: Parameters<Parameters<typeof defineRoutes>[0]>[0]) => Parameters<typeof tableRoutes>[0], rows: DataTable) =>
  new Router().load(defineRoutes((Root) => tableRoutes(decide(Root) as never, rows as never)));

describe('tableRoutes — a registrar that lets everyone call its routes', () => {
  it('refuses an action and an export without .authorize(), and says how to fix it', () => {
    expect(() => load((Root) => Root.authorize(everyone) as never, table({ authorized: false }))).toThrow(/action 'deactivate', export 'csv' have no \.authorize\(\)/);
  });

  it('loads when each action and export decides for itself', () => {
    expect(() => load((Root) => Root.authorize(everyone) as never, table({ authorized: true }))).not.toThrow();
  });

  it('loads unauthorized actions under a registrar that decides with a check of its own', () => {
    expect(() => load((Root) => Root.authorize(() => true) as never, table({ authorized: false }))).not.toThrow();
  });
});
