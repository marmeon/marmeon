import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, planOf } from './plan.ts';

// The migrations the framework's packages publish into an app pass the MySQL plan check: one that fails it stops every pending
// migration of the app, its own and the app's, before the first statement. A step that raw SQL leaves out on MySQL (`mysql: null`)
// passes by design; what the database itself refuses on MySQL is checked when the migration runs.
const packages = new URL('../../../', import.meta.url);
const stubs = readdirSync(packages, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const dir = new URL(`${entry.name}/stubs/migrations/`, packages);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => ({ name: `${entry.name}/${file}`, url: new URL(file, dir) }));
  });

describe('the migrations of the packages on MySQL', () => {
  it('finds the stub migrations, the search table among them', () => {
    expect(stubs.map((stub) => stub.name)).toContain('search/0001_01_01_000000_create_search_documents_table.ts');
  });

  it.each(stubs.map((stub) => [stub.name, stub.url] as const))('passes the plan check: %s', async (name, url) => {
    const migration = (await import(/* @vite-ignore */ url.href)).default;
    expect(() => check('mysql', planOf(migration, 'up', name))).not.toThrow();
  });
});
