import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupByServices, SERVICE_VARIABLES, serviceFiles, tripwireEnv, type Service } from './services.ts';
import { tempDir } from './temp-dir.js';

const repo = join(import.meta.dirname, '..', '..');

/** A tree of files under a temporary root; returns the root. */
function tree(files: Record<string, string>): string {
  const root = tempDir('marmeon-services-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function servicesOf(files: Record<string, string>, file: string): Service[] {
  const root = tree(files);
  return [...serviceFiles(root, [file]).get(file)!].sort();
}

// In pieces: the selection reads this file too, and these words would select it.
const REFRESH = 're' + 'fresh';
const VITEST = 'vi' + 'test';
const FIXTURES = '__fixtu' + 'res__';
const PGSQL = SERVICE_VARIABLES.pgsql;

describe('the services a test file needs', () => {
  it('follows relative imports to a helper that reads the Postgres URL — also two levels deep', () => {
    const files = {
      'packages/a/src/a.test.ts': "import { db } from './__fixtures__/db.ts';",
      'packages/a/src/__fixtures__/db.ts': `export const db = process.env.${PGSQL};`,
      'packages/b/src/b.test.ts': "import './__fixtures__/outer.ts';",
      'packages/b/src/__fixtures__/outer.ts': "export * from './inner.js';",
      'packages/b/src/__fixtures__/inner.ts': `export const url = process.env.${PGSQL};`,
    };
    expect(servicesOf(files, 'packages/a/src/a.test.ts')).toEqual(['pgsql']);
    expect(servicesOf(files, 'packages/b/src/b.test.ts')).toEqual(['pgsql']);
  });

  it('follows import type, a dynamic import with a literal and an index file', () => {
    const files = {
      'packages/a/src/type.test.ts': "import type { X } from './__fixtures__/x.ts';",
      'packages/a/src/dynamic.test.ts': "const x = await import('./__fixtures__/x.ts');",
      'packages/a/src/index.test.ts': "import { x } from './__fixtures__';",
      'packages/a/src/__fixtures__/x.ts': `export const x = process.env.${SERVICE_VARIABLES.redis};`,
      'packages/a/src/__fixtures__/index.ts': "export { x } from './x.ts';",
    };
    for (const name of ['type', 'dynamic', 'index']) expect(servicesOf(files, `packages/a/src/${name}.test.ts`)).toEqual(['redis']);
  });

  it('resolves .js and .jsx specifiers to the TypeScript source, as TypeScript does', () => {
    const files = {
      'packages/a/src/a.test.ts': "import './view.js'; import './other.jsx';",
      'packages/a/src/view.tsx': `export const url = process.env.${PGSQL};`,
      'packages/a/src/b.test.ts': "import './other.jsx';",
      'packages/a/src/other.tsx': `export const url = process.env.${SERVICE_VARIABLES.redis};`,
    };
    expect(servicesOf(files, 'packages/a/src/a.test.ts')).toEqual(['pgsql', 'redis']);
    expect(servicesOf(files, 'packages/a/src/b.test.ts')).toEqual(['redis']);
  });

  it('does not follow a package specifier', () => {
    const files = {
      'packages/a/src/a.test.ts': "import { x } from '@marmeon/other'; import { y } from 'node:fs';",
      'packages/other/src/index.ts': `export const x = process.env.${PGSQL};`,
    };
    expect(servicesOf(files, 'packages/a/src/a.test.ts')).toEqual([]);
  });

  it('selects an app helper that refreshes a database, but not a package’s production code that names it', () => {
    const files = {
      'apps/site/modules/m/m.test.ts': "import { open } from './support.ts';",
      'apps/site/modules/m/support.ts': `export const open = () => createTestApp(app, { database: '${REFRESH}' });`,
      'apps/site/package.json': '{}',
      'packages/testing/src/error.test.ts': "import { message } from './message.ts';",
      'packages/testing/src/message.ts': `export const message = "use database: '${REFRESH}'";`,
    };
    expect(servicesOf(files, 'apps/site/modules/m/m.test.ts')).toEqual(['pgsql']);
    expect(servicesOf(files, 'packages/testing/src/error.test.ts')).toEqual([]);
  });

  it('selects a test in an app that depends on @marmeon/database, and not one in an app that does not', () => {
    const files = {
      'apps/with/package.json': JSON.stringify({ dependencies: { '@marmeon/database': 'workspace:*' } }),
      'apps/with/modules/a/a.test.ts': 'export {};',
      'apps/without/package.json': JSON.stringify({ dependencies: { '@marmeon/http': 'workspace:*' } }),
      'apps/without/modules/a/a.test.ts': 'export {};',
    };
    expect(servicesOf(files, 'apps/with/modules/a/a.test.ts')).toEqual(['pgsql']);
    expect(servicesOf(files, 'apps/without/modules/a/a.test.ts')).toEqual([]);
  });

  it('selects a test that starts a nested Vitest: its refresh tests inherit DB_CONNECTION', () => {
    const files = { 'packages/a/src/nested.test.ts': `spawn('node_modules/.bin/${VITEST}', ['run']);` };
    expect(servicesOf(files, 'packages/a/src/nested.test.ts')).toEqual(['pgsql']);
  });

  it('throws on a package specifier that reaches into a fixtures directory', () => {
    const root = tree({ 'packages/a/src/a.test.ts': `import { y } from '@marmeon/x/src/${FIXTURES}/y.ts';` });
    expect(() => serviceFiles(root, ['packages/a/src/a.test.ts'])).toThrow(/import fixtures relatively/);
  });
});

describe('the projects', () => {
  const selection = new Map<string, ReadonlySet<Service>>([
    ['a.test.ts', new Set<Service>()],
    ['b.test.ts', new Set<Service>(['redis', 'pgsql'])],
    ['c.test.ts', new Set<Service>(['pgsql', 'redis'])],
    ['d.test.ts', new Set<Service>(['s3'])],
  ]);

  it('groups the files by their set of services, the name sorted', () => {
    const groups = groupByServices(selection);
    expect([...groups.keys()].sort()).toEqual(['pgsql+redis', 'plain', 's3']);
    expect(groups.get('pgsql+redis')!.files).toEqual(['b.test.ts', 'c.test.ts']);
  });

  it('sets the tripwire for every service outside the set', () => {
    const plain = tripwireEnv(new Set());
    expect(Object.keys(plain).sort()).toEqual(['DB_CONNECTION', 'DB_URL', SERVICE_VARIABLES.pgsql, SERVICE_VARIABLES.redis, SERVICE_VARIABLES.s3].sort());
    expect(Object.entries(plain).filter(([key]) => key !== 'DB_CONNECTION').every(([, value]) => value.includes('.invalid'))).toBe(true);

    const pgsql = tripwireEnv(new Set<Service>(['pgsql']));
    expect(Object.keys(pgsql).sort()).toEqual([SERVICE_VARIABLES.redis, SERVICE_VARIABLES.s3].sort());

    expect(Object.keys(tripwireEnv(new Set<Service>(['pgsql', 'redis'])))).toEqual([SERVICE_VARIABLES.s3]);
  });
});

describe('this repository', () => {
  const candidates = globSync(['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/modules/**/*.test.{ts,tsx}'], {
    cwd: repo,
    exclude: (name) => name === 'node_modules' || name === 'dist',
  });
  const selection = serviceFiles(repo, candidates);

  it('runs the session store contract on Postgres and Redis', () => {
    expect([...selection.get('packages/session/src/stores/stores.test.ts')!].sort()).toEqual(['pgsql', 'redis']);
  });

  it('runs a storage test that reads the disks on S3', () => {
    const storage = [...selection].filter(([file]) => file.startsWith('packages/storage/'));
    expect(storage.some(([, services]) => services.has('s3'))).toBe(true);
  });

  it('runs a test of the HTTP package that needs nothing on no service', () => {
    const http = [...selection].filter(([file]) => file.startsWith('packages/http/src/')).map(([, services]) => services);
    expect(http.some((services) => services.size === 0)).toBe(true);
  });

  it('runs the web app on Postgres and a website test that opens no database on none', () => {
    const app = (name: string) => [...selection].filter(([file]) => file.startsWith(`apps/${name}/`));
    expect(app('web-app').every(([, services]) => services.has('pgsql'))).toBe(true);
    expect(selection.get('apps/website/modules/docs/search.test.ts')!.size).toBe(0);
  });
});
