import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupByServices, SERVICE_VARIABLES, serviceFiles, processFiles, splitTiming, timingEnv, tripwireEnv, type Service } from './services.ts';
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
const CHILD_PROCESS = 'node:child_' + 'process';
const SSR_TRUE = 'ss' + 'r: true';

function startsOf(files: Record<string, string>, file: string): boolean {
  return processFiles(tree(files), [file]).has(file);
}

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

  it('selects a test that starts a nested Vitest: its refresh tests inherit DB_DRIVER', () => {
    const files = { 'packages/a/src/nested.test.ts': `spawn('node_modules/.bin/${VITEST}', ['run']);` };
    expect(servicesOf(files, 'packages/a/src/nested.test.ts')).toEqual(['pgsql']);
  });

  it('throws on a package specifier that reaches into a fixtures directory', () => {
    const root = tree({ 'packages/a/src/a.test.ts': `import { y } from '@marmeon/x/src/${FIXTURES}/y.ts';` });
    expect(() => serviceFiles(root, ['packages/a/src/a.test.ts'])).toThrow(/import fixtures relatively/);
  });
});

describe('the tests that start processes', () => {
  it('finds a child process import in a helper the test imports', () => {
    const files = {
      'packages/a/src/a.test.ts': "import { run } from './__fixtures__/run.ts';",
      'packages/a/src/__fixtures__/run.ts': `import { spawn } from '${CHILD_PROCESS}'; export const run = spawn;`,
    };
    expect(startsOf(files, 'packages/a/src/a.test.ts')).toBe(true);
  });

  it('finds a dynamic import and a require of child_process', () => {
    expect(startsOf({ 'a.test.ts': `const { spawn } = await import('${CHILD_PROCESS}');` }, 'a.test.ts')).toBe(true);
    expect(startsOf({ 'a.test.ts': `const { spawn } = require('${CHILD_PROCESS}');` }, 'a.test.ts')).toBe(true);
  });

  it('finds a test that starts the Vite dev server or resolves the package to run it', () => {
    expect(startsOf({ 'a.test.ts': 'const { vite } = await createViteDevRenderer({});' }, 'a.test.ts')).toBe(true);
    expect(startsOf({ 'a.test.ts': "const dir = createRequire(import.meta.url).resolve('vite/package.json');" }, 'a.test.ts')).toBe(true);
  });

  it('finds a nested Vitest', () => {
    expect(startsOf({ 'a.test.ts': `const bin = 'node_modules/.bin/${VITEST}';` }, 'a.test.ts')).toBe(true);
  });

  it('finds a value import of vite, but not a type import', () => {
    expect(startsOf({ 'a.test.ts': "import { createServer } from 'vite';" }, 'a.test.ts')).toBe(true);
    expect(startsOf({ 'a.test.ts': "import type { Plugin } from 'vite';" }, 'a.test.ts')).toBe(false);
  });

  it('finds a test app that renders through SSR', () => {
    expect(startsOf({ 'a.test.ts': `const app = await createTestApp(application, { ${SSR_TRUE} });` }, 'a.test.ts')).toBe(true);
    expect(startsOf({ 'a.test.ts': "const app = await createTestApp(application, { ssr: 'stream' });" }, 'a.test.ts')).toBe(true);
  });

  it('is false for a file without any of these', () => {
    expect(startsOf({ 'a.test.ts': "import { b } from './b.ts';", 'b.ts': 'export const b = 1;' }, 'a.test.ts')).toBe(false);
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

  it('keeps the tests that start processes in projects of their own, per set of services', () => {
    const groups = groupByServices(selection, new Set(['b.test.ts', 'a.test.ts']));
    expect([...groups.keys()].sort()).toEqual(['pgsql+redis', 'pgsql+redis-process', 'plain-process', 's3']);
    expect(groups.get('pgsql+redis-process')!.files).toEqual(['b.test.ts']);
    expect(groups.get('plain-process')!.process).toBe(true);
    expect(groups.get('s3')!.process).toBe(false);
  });

  it('keeps a timing test out of the service projects, whatever it imports', () => {
    const { timing, other } = splitTiming(['apps/web-app/modules/auth/registration.timing.test.ts', 'packages/auth/src/auth.test.ts', 'packages/auth/src/hashing.timing.test.tsx']);
    expect(timing).toEqual(['apps/web-app/modules/auth/registration.timing.test.ts', 'packages/auth/src/hashing.timing.test.tsx']);
    expect(other).toEqual(['packages/auth/src/auth.test.ts']);
    const root = tree({ 'a.timing.test.ts': `export const url = process.env.${PGSQL};` });
    expect(groupByServices(serviceFiles(root, splitTiming(['a.timing.test.ts']).other)).size).toBe(0);
  });

  it('pins the timing project to SQLite with the tripwires of every service', () => {
    const env = timingEnv();
    expect(env.DB_DRIVER).toBe('sqlite');
    expect([SERVICE_VARIABLES.pgsql, SERVICE_VARIABLES.redis, SERVICE_VARIABLES.s3].every((name) => env[name]?.includes('.invalid'))).toBe(true);
  });

  it('sets the tripwire for every service outside the set', () => {
    const plain = tripwireEnv(new Set());
    expect(Object.keys(plain).sort()).toEqual(['DB_DRIVER', 'DB_URL', SERVICE_VARIABLES.pgsql, SERVICE_VARIABLES.redis, SERVICE_VARIABLES.s3].sort());
    expect(Object.entries(plain).filter(([key]) => key !== 'DB_DRIVER').every(([, value]) => value.includes('.invalid'))).toBe(true);

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

  it('puts a test that renders through Vite in the process projects and a plain unit test outside', () => {
    const found = processFiles(repo, [
      'apps/web-app/modules/members/members.test.ts',
      'apps/web-app/modules/dashboard/stream.test.ts',
      'packages/server/src/vite.test.ts',
      'apps/website/modules/docs/search.test.ts',
    ]);
    expect([...found].sort()).toEqual(['apps/web-app/modules/dashboard/stream.test.ts', 'apps/web-app/modules/members/members.test.ts', 'packages/server/src/vite.test.ts']);
  });

  it('runs the web app on Postgres and a website test that opens no database on none', () => {
    const app = (name: string) => [...selection].filter(([file]) => file.startsWith(`apps/${name}/`));
    expect(app('web-app').every(([, services]) => services.has('pgsql'))).toBe(true);
    expect(selection.get('apps/website/modules/docs/search.test.ts')!.size).toBe(0);
  });
});
