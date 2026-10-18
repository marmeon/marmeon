import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { loadMigration, spendImport, type MigrationSource } from '../migrations/load.ts';
import { PROJECTION_FILE, PROJECTION_FORMAT, forgetProjections, loadProjection, parseProjectionFile, readProjection, writeProjection } from './projection-file.ts';
import { planOf } from './plan.ts';
import { applyPlan, emptyProjection, type SchemaProjection } from './projection.ts';
import type { Schema } from './schema.ts';

/** A migration file in a directory of its own: plain objects, so the file needs no package of this repository. */
function app(...sources: string[]): { root: string; files: MigrationSource[]; edit: (index: number, source: string) => void } {
  const root = tempDir('marmeon-projection-file-');
  const directory = join(root, 'migrations');
  mkdirSync(directory);
  const files = sources.map((source, i): MigrationSource => {
    const path = join(directory, `2026_01_0${i + 1}_000000_step_${i}.ts`);
    writeFileSync(path, source);
    return { name: `2026_01_0${i + 1}_000000_step_${i}`, module: 'app', path };
  });
  return { root, files, edit: (index, source) => writeFileSync(files[index]!.path, source) };
}

const create = (table: string) => `export default { up(schema) { schema.create('${table}', (t) => { t.id(); t.string('name'); }); } };\n`;

/** The projection a stand-in for the migrations' plans gives: one table per call. */
function projecting(...tables: string[]): SchemaProjection {
  const up = (schema: Schema) => {
    for (const name of tables) schema.create(name, (t) => t.id());
  };
  return applyPlan(emptyProjection, planOf({ up }, 'up'), { name: 'm', module: 'app' });
}

const names = (projection: SchemaProjection) => [...projection.tables.keys()];

describe('the schema projection file', () => {
  it('computes the projection of fresh migrations and writes it', async () => {
    forgetProjections();
    const { root, files } = app(create('users'), create('posts'));

    const projection = await loadProjection(root, files);

    expect(names(projection)).toEqual(['users', 'posts']);
    const written = parseProjectionFile(readFileSync(join(root, PROJECTION_FILE), 'utf8'))!;
    expect(written.format).toBe(PROJECTION_FORMAT);
    expect(written.migrations.map(({ name, module }) => ({ name, module }))).toEqual(files.map(({ name, module }) => ({ name, module })));
    expect(written.migrations.every((m) => /^[0-9a-f]{64}$/.test(m.sha256))).toBe(true);
    expect(Object.keys(written.tables)).toEqual(['users', 'posts']);
    expect(readProjection(root, files)).toEqual(projection);
  });

  it('uses a file that fits the migrations without importing one of them', async () => {
    forgetProjections();
    const { root, files } = app(create('users'));
    const first = await loadProjection(root, files);
    forgetProjections();
    const project = vi.fn(async () => projecting('elsewhere'));

    const second = await loadProjection(root, files, { project });

    expect(project).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it('asks the disk once per process for the same files', async () => {
    forgetProjections();
    const { root, files } = app(create('users'));
    const project = vi.fn(async () => projecting('users'));

    await loadProjection(root, files, { project });
    await loadProjection(root, files, { project });

    expect(project).toHaveBeenCalledTimes(1);
  });

  it('computes the projection again when a migration file changed', async () => {
    forgetProjections();
    const { root, files, edit } = app(create('users'), create('posts'));
    await loadProjection(root, files);
    forgetProjections();
    edit(1, create('articles'));
    const project = vi.fn(async () => projecting('users', 'articles'));

    const projection = await loadProjection(root, files, { project });

    expect(project).toHaveBeenCalledTimes(1);
    expect(names(projection)).toEqual(['users', 'articles']);
    expect(Object.keys(parseProjectionFile(readFileSync(join(root, PROJECTION_FILE), 'utf8'))!.tables)).toEqual(['users', 'articles']);
  });

  it('writes nothing, and asks again next time, when a file changed while its plan was computed', async () => {
    forgetProjections();
    const { root, files, edit } = app(create('users'));
    const original = create('users');
    // The file is edited after its bytes were hashed: the plan may belong to either version.
    const project = vi.fn(async () => {
      edit(0, create('people'));
      return projecting('users');
    });
    await loadProjection(root, files, { project });
    expect(readProjection(root, files)).toBeUndefined();
    expect(() => readFileSync(join(root, PROJECTION_FILE))).toThrow();

    // Back to the bytes it was hashed as: asked again, not served from the first answer.
    edit(0, original);
    const again = vi.fn(async () => projecting('users'));
    await loadProjection(root, files, { project: again });
    expect(again).toHaveBeenCalledTimes(1);
    expect(readProjection(root, files)).toBeDefined();
  });

  it('imports a file again, not from the module kept for its old hash, once that import is spent', async () => {
    const { files, edit } = app("export default { up() {}, marker: 'one' };\n");
    const file = { ...files[0]!, sha256: 'x'.repeat(64) };
    expect(await loadMigration(file)).toMatchObject({ marker: 'one' });
    edit(0, "export default { up() {}, marker: 'two' };\n");
    expect(await loadMigration(file)).toMatchObject({ marker: 'one' });
    spendImport(file.path, file.sha256);
    expect(await loadMigration(file)).toMatchObject({ marker: 'two' });
  });

  it('computes it again when a migration file was added or removed', async () => {
    forgetProjections();
    const { root, files } = app(create('users'), create('posts'));
    await loadProjection(root, files);

    for (const changed of [files.slice(0, 1), files.slice(1)]) {
      forgetProjections();
      const project = vi.fn(async () => projecting('x'));
      await loadProjection(root, changed, { project });
      expect(project).toHaveBeenCalledTimes(1);
    }
  });

  it('computes it again when a migration file has another module, with the same path and hash', async () => {
    forgetProjections();
    const { root, files } = app(create('users'));
    await loadProjection(root, files);
    forgetProjections();
    const project = vi.fn(async () => projecting('users'));

    await loadProjection(root, [{ ...files[0]!, module: 'other' }], { project });

    expect(project).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a column type that is not text', (file: Record<string, any>) => ({ ...file, tables: { users: { ...file.tables.users, columns: [{ ...file.tables.users.columns[0], type: { sqlite: 1, pgsql: 'bigint' } }] } } })],
    ['an unknown default', (file: Record<string, any>) => ({ ...file, tables: { users: { ...file.tables.users, columns: [{ ...file.tables.users.columns[0], default: 'random' }] } } })],
    ['a retired flag that is not a boolean', (file: Record<string, any>) => ({ ...file, tables: { users: { ...file.tables.users, columns: [{ ...file.tables.users.columns[0], retired: 'yes' }] } } })],
    ['an unknown marker', (file: Record<string, any>) => ({ ...file, tables: { users: { ...file.tables.users, markers: ['hidden'] } } })],
    ['an unknown onDelete', (file: Record<string, any>) => ({ ...file, tables: { users: { ...file.tables.users, foreignKeys: [{ column: 'id', references: 'x', referenced: 'id', onDelete: 'explode' }] } } })],
  ])('does not accept a file with %s', (_, change) => {
    const file = JSON.parse(readFileSync(new URL('../__fixtures__/formats/schema-projection/v2.json', import.meta.url), 'utf8')) as Record<string, any>;
    expect(parseProjectionFile(JSON.stringify(file))).toBeDefined();
    expect(parseProjectionFile(JSON.stringify(change(file)))).toBeUndefined();
  });

  it('keeps the projection in memory whatever stops the write, a file where the directory should be included', async () => {
    forgetProjections();
    const { root, files } = app(create('users'));
    writeFileSync(join(root, '.marmeon'), 'not a directory');
    const warn = vi.fn();

    expect(names(await loadProjection(root, files, { onUnwritable: warn }))).toEqual(['users']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another format', (file: Record<string, unknown>) => ({ ...file, format: 3 })],
    ['another version of the package', (file: Record<string, unknown>) => ({ ...file, database: '0.0.0-other' })],
    ['a table that is not one', (file: Record<string, unknown>) => ({ ...file, tables: { users: { name: 'users' } } })],
  ])('computes it again for a file of %s', async (_, change) => {
    forgetProjections();
    const { root, files } = app(create('users'));
    await loadProjection(root, files);
    forgetProjections();
    const path = join(root, PROJECTION_FILE);
    writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)));
    const project = vi.fn(async () => projecting('users'));

    await loadProjection(root, files, { project });

    expect(project).toHaveBeenCalledTimes(1);
    expect(parseProjectionFile(readFileSync(path, 'utf8'))).toBeDefined();
  });

  it('computes it again for a file that is not JSON', async () => {
    forgetProjections();
    const { root, files } = app(create('users'));
    mkdirSync(join(root, '.marmeon'));
    writeFileSync(join(root, PROJECTION_FILE), '{ not json');

    expect(names(await loadProjection(root, files))).toEqual(['users']);
  });

  it('discards a file whose tables belong to another version of a migration, though every other hash fits', async () => {
    forgetProjections();
    const { root, files, edit } = app(create('users'), create('posts'));
    await loadProjection(root, files);
    forgetProjections();
    // Someone swaps the tables for a changed file's and edits that file: the hash of the changed file no longer fits the list.
    const path = join(root, PROJECTION_FILE);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { tables: Record<string, unknown> };
    file.tables = { ...file.tables, secrets_leak: { ...(file.tables.users as object), name: 'secrets_leak' } };
    writeFileSync(path, JSON.stringify(file));
    edit(1, create('articles'));
    const project = vi.fn(async () => projecting('users', 'articles'));

    const projection = await loadProjection(root, files, { project });

    expect(project).toHaveBeenCalledTimes(1);
    expect(names(projection)).not.toContain('secrets_leak');
    expect(names(readProjection(root, files)!)).toEqual(['users', 'articles']);
  });

  it('keeps the projection in memory, with one warning for the process, when the directory cannot be written', async () => {
    if (process.getuid?.() === 0) return;
    forgetProjections();
    const locked = () => {
      const { root, files } = app(create('users'));
      chmodSync(root, 0o500);
      onTestFinished(() => chmodSync(root, 0o700));
      return { root, files };
    };
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    onTestFinished(() => emit.mockRestore());
    const [first, second] = [locked(), locked()];

    expect(names(await loadProjection(first.root, first.files, { onUnwritable: () => {} }))).toEqual(['users']);
    expect(emit).not.toHaveBeenCalled();
    expect(names(await loadProjection(second.root, second.files))).toEqual(['users']);
    expect(emit).toHaveBeenCalledTimes(1);
    // Asking again for the same files asks nothing of the disk and warns no more.
    await loadProjection(second.root, second.files);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(readProjection(first.root, first.files)).toBeUndefined();
  });

  it('does not rewrite a file that has the content already', async () => {
    forgetProjections();
    const { root, files } = app(create('users'));
    const projection = await loadProjection(root, files);
    const path = join(root, PROJECTION_FILE);
    const before = readFileSync(path, 'utf8');
    chmodSync(join(root, '.marmeon'), 0o500);
    onTestFinished(() => chmodSync(join(root, '.marmeon'), 0o700));

    expect(() => writeProjection(root, projection, files)).not.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('reads every fixture of the current format, and computes the projection again for one of an older format', () => {
    const directory = new URL('../__fixtures__/formats/schema-projection/', import.meta.url);
    const fixtures = readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(fixtures).toContain(`v${PROJECTION_FORMAT}.json`);
    for (const name of fixtures) {
      const text = readFileSync(new URL(name, directory), 'utf8');
      const format = Number(/^v(\d+)/.exec(name)![1]);
      expect((JSON.parse(text) as { format: number }).format, name).toBe(format);
      const file = parseProjectionFile(text);
      if (format !== PROJECTION_FORMAT) {
        // The file is a cache: another format is not an error, the projection is computed from the migrations and written over it.
        expect(file, name).toBeUndefined();
        continue;
      }
      expect(file, name).toBeDefined();
      expect(Object.keys(file!.tables)).toContain('users');
      expect(file!.tables.users!.columns.some((column) => column.secret)).toBe(true);
    }
  });
});
