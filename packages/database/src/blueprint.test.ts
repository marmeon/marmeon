import type { Application, ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { Migrator, ForeignIdColumn, type Connections } from './index.ts';

type Spec = ConstructorParameters<typeof ForeignIdColumn>[0];

/** The table `foreignId(name).constrained(...)` ends up referencing. */
function referenced(name: string, ...args: [] | [string]): string | undefined {
  const spec = { name, type: { sqlite: 'integer', pgsql: 'bigint' }, nullable: false, primary: false, identity: false, unique: false, secret: false } as Spec;
  new ForeignIdColumn(spec).constrained(...args);
  return (spec as { references?: { table: string } }).references?.table;
}

describe('constrained() guesses the table', () => {
  it.each([
    ['user_id', 'users'],
    ['category_id', 'categories'],
    ['key_id', 'keys'],
    ['status_id', 'statuses'],
    ['address_id', 'addresses'],
    ['box_id', 'boxes'],
    ['branch_id', 'branches'],
    ['dish_id', 'dishes'],
  ])('%s → %s', (column, table) => {
    expect(referenced(column)).toBe(table);
  });

  it('takes the table that is named', () => {
    expect(referenced('person_id', 'people')).toBe('people');
    expect(referenced('category_id', 'category')).toBe('category');
  });
});

describe.each(drivers)('a guessed table on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    const modules: ModuleDefinition[] = [{ name: 'plurals', migrations: new URL('./__fixtures__/migrations/plurals/', import.meta.url) }];
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
  });
  afterAll(() => close());

  it('references the plural table, and the metadata finds the relation', async () => {
    await connections.get<any>().selectFrom('products').select('id').execute(); // loads the metadata
    const relations = connections.metadata().relations;
    expect(relations.get('products')?.get('category')).toMatchObject({ kind: 'belongsTo', table: 'categories', foreignKey: 'category_id' });
    expect(relations.get('categories')?.get('products')).toMatchObject({ kind: 'hasMany', table: 'products' });
  });
});
