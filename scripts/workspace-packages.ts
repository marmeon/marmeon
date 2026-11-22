/**
 * The packages of an app's own workspace under test (`pnpm pack:smoke`), in a packed app with `vitest@^5.1.1`: packages inside its root, one
 * exporting TypeScript sources, one behind the `@marmeon/source` condition, one only its built files, and a guard with a package that imports it.
 * A test imports their classes through Vitest's module runner, discovery through Node's `import()` — unless the app's setup file imports
 * `virtual:marmeon/test-packages` (docs/vite.md#packages-of-your-workspace). Three runs of the tests, each a Vitest process of at most two workers:
 *
 * 1. without the import: the classes are two copies, nothing else differs from a version without the import, and the same suite holds with
 *    `external: [/node_modules/]` and with the native runner;
 * 2. with the import: one instance, one evaluation, the mocks reach the boot;
 * 3. run 2 again with `external: [/node_modules/]` and with `@marmeon/vite` linked from outside the app's workspace root.
 *
 * A function, no command of its own.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freePort, SmokeError } from './pack-smoke.ts';

/** What the check needs of the smoke app: its directory and a way to run a command in it. */
export interface WorkspaceApp {
  readonly app: string;
  readonly env: NodeJS.ProcessEnv;
  run(command: string, args: string[], env?: NodeJS.ProcessEnv): string;
  /** `marmeon start` until `path` answers 200, then ends it. */
  serve(path: string): Promise<void>;
}

/** The files of a package whose TypeScript sources the app's tests import: `Name`, `NAME` and `name` are filled in. */
function sourcePackage(name: string, extra: { manifest?: object; index?: string } = {}): Record<string, string> {
  const Name = name[0]!.toUpperCase() + name.slice(1);
  const manifest = {
    name: `@smoke/${name}`,
    version: '0.0.0',
    type: 'module',
    exports: { '.': { types: './src/index.ts', default: './src/index.ts' } },
    marmeon: { providers: [`${Name}ServiceProvider`] },
    ...extra.manifest,
  };
  return {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src/index.ts': extra.index ?? `export * from './${name}.ts';\nexport * from './${Name}ServiceProvider.ts';\n`,
    [`src/${name}.ts`]: `import { Application, token } from '@marmeon/core';
import { Controller } from '@marmeon/http';

// How often a module of this package ran in this process.
const evaluated = globalThis as { smokeEvaluations?: Record<string, number> };
evaluated.smokeEvaluations = { ...evaluated.smokeEvaluations, ${name}: (evaluated.smokeEvaluations?.${name} ?? 0) + 1 };

export const ${name.toUpperCase()} = token<string>('smoke.${name}');

export class ${Name}Service {
  readonly app: Application;

  constructor(app: Application) {
    this.app = app;
  }
}

export class ${Name}Controller extends Controller {
  readonly #service: ${Name}Service;

  constructor(service: ${Name}Service) {
    super();
    this.#service = service;
  }

  handle() {
    return Response.json({ app: this.#service.app instanceof Application });
  }
}
`,
    [`src/${Name}ServiceProvider.ts`]: `import type { Container, ServiceProvider } from '@marmeon/core';
import { ${name.toUpperCase()}, ${Name}Service } from './${name}.ts';
import { greeting } from './greeting.ts';

export class ${Name}ServiceProvider implements ServiceProvider {
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: '${name}s' };

  register(container: Container): void {
    container.instance(${name.toUpperCase()}, greeting());
    container.singleton(${Name}Service);
  }
}
`,
    'src/greeting.ts': `export function greeting(): string {\n  return '${name}';\n}\n`,
    [`stubs/migrations/2026_01_01_000000_create_${name}s_table.ts`]: `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => {
    schema.create('${name}s', (table) => {
      table.text('id').primary();
    });
  },
  down: (schema) => {
    schema.drop('${name}s');
  },
});
`,
  };
}

const KIT = sourcePackage('kit', { manifest: { exports: { '.': { types: './src/index.ts', default: './src/index.ts' }, './greeting': { types: './src/greeting.ts', default: './src/greeting.ts' } } } });

const BUILT_JSON = {
  name: '@smoke/built',
  version: '0.0.0',
  type: 'module',
  exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  marmeon: { providers: ['BuiltServiceProvider'] },
};

/** Only built files, with declarations (discovery reads the injection lists from them). */
const BUILT: Record<string, string> = {
  'package.json': `${JSON.stringify(BUILT_JSON, null, 2)}\n`,
  'dist/index.js': `import { Application, token } from '@marmeon/core';
import { Controller } from '@marmeon/http';

export const BUILT = token('smoke.built');

export class BuiltService {
  app;

  constructor(app) {
    this.app = app;
  }
}

export class BuiltController extends Controller {
  #service;

  constructor(service) {
    super();
    this.#service = service;
  }

  handle() {
    return Response.json({ app: this.#service.app instanceof Application });
  }
}

export class BuiltServiceProvider {
  register(container) {
    container.instance(BUILT, 'built');
    container.singleton(BuiltService);
  }
}
`,
  'dist/index.d.ts': `import { Application, type Container, type ServiceProvider, type Token } from '@marmeon/core';
import { Controller } from '@marmeon/http';

export declare const BUILT: Token<string>;
export declare class BuiltService {
  readonly app: Application;
  constructor(app: Application);
}
export declare class BuiltController extends Controller {
  constructor(service: BuiltService);
  handle(): Response;
}
export declare class BuiltServiceProvider implements ServiceProvider {
  register(container: Container): void;
}
`,
};

/** Behind `@marmeon/source`: a build (no such condition) gets the built files, the same classes as the sources (the tests never load them). */
const SOURCED = {
  ...sourcePackage('sourced', { manifest: { exports: { '.': { '@marmeon/source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } } } }),
  ...Object.fromEntries(Object.entries(BUILT).filter(([path]) => path.startsWith('dist/')).map(([path, text]) => [path, text.replaceAll('Built', 'Sourced').replaceAll('BUILT', 'SOURCED').replaceAll('built', 'sourced')])),
};

/** A guard (no provider) and a package that imports it. */
const GUARD: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: '@smoke/guard', version: '0.0.0', type: 'module', exports: { '.': { types: './src/index.ts', default: './src/index.ts' } } }, null, 2)}\n`,
  'src/index.ts': "export function charge(): string {\n  return 'real';\n}\n",
};

const AUDIT: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: '@smoke/audit', version: '0.0.0', type: 'module', exports: { '.': { types: './src/index.ts', default: './src/index.ts' } }, marmeon: { providers: ['AuditServiceProvider'] } }, null, 2)}\n`,
  'src/index.ts': `import { token, type Container, type ServiceProvider } from '@marmeon/core';
import { charge } from '@smoke/guard';

export const AUDIT = token<string>('smoke.audit');

export class AuditServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.instance(AUDIT, charge());
  }
}
`,
};

/**
 * An app of its own (`odd/app`) with one package whose directory has a "#" in its name (`odd/pkg#odd`): cut at the "#", the path is `odd/pkg`, and
 * `odd/pkg.ts` is the file Vite would find there. The link into the app's `node_modules` is made by the test.
 */
const ODD: Record<string, string> = {
  'odd/app/package.json': `${JSON.stringify({ name: 'odd-app', type: 'module', dependencies: { '@smoke/odd': '1.0.0' } })}\n`,
  'odd/pkg#odd/package.json': `${JSON.stringify({ name: '@smoke/odd', version: '1.0.0', type: 'module', exports: { '.': { types: './src/index.ts', default: './src/index.ts' } }, marmeon: { providers: ['OddServiceProvider'] } })}\n`,
  'odd/pkg#odd/src/index.ts': 'export class OddServiceProvider {\n  register(): void {}\n}\n',
  'odd/pkg.ts': "(globalThis as { smokeSibling?: boolean }).smokeSibling = true;\nexport class OddServiceProvider {\n  register(): void {}\n}\n",
};

const UI_JSON = {
  name: '@smoke/ui',
  version: '0.0.0',
  type: 'module',
  exports: { './components': { types: './src/components.ts', default: './src/components.ts' } },
  marmeon: { namespace: 'ui' },
};

/** A package with a namespace: its modules are compiled by the app's Vite, so every plugin of the app sees them. */
const UI: Record<string, string> = {
  'package.json': `${JSON.stringify(UI_JSON, null, 2)}\n`,
  'src/components.ts': "export const MARK = 'smoke-ui-component';\n",
};

/** A plugin of the app that notes which environment of Vite transformed a module of the namespace package. */
const RECORDER = [
  '    {',
  "      name: 'smoke-recorder',",
  '      transform(_code, id) {',
  "        if (id.includes('/packages/ui/')) appendFileSync(process.env.SMOKE_RECORD!, `${this.environment.name} ${id}\\n`);",
  '      },',
  '    },',
  '',
].join('\n');

/** The tests of a run without the import: the ones whose result the import changes, and the ones it must not. */
const PLAIN_TESTS = ['hash', 'instances', 'missing'];

const VITEST_CONFIG = String.raw`import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { marmeon } from '@marmeon/vite';
import { defineConfig } from 'vitest/config';

// The files of this run, from the process that starts Vitest; the dom project takes its own.
const files = (process.env.SMOKE_FILES ?? '').split(',').filter(Boolean).map((name) => 'modules/smoke/' + name + '.test.ts');
const dom = 'modules/smoke/dom.test.ts';
const escape = (text: string) => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
// installed dependencies external, or one package of the workspace external by its real path
const externals: Record<string, RegExp[] | undefined> = { deps: [/node_modules/], package: [new RegExp(escape(realpathSync('packages/kit')))] };
const external = externals[process.env.SMOKE_EXTERNAL ?? ''];
// where the @marmeon/vite in use lies
if (process.env.SMOKE_VITE_USED) writeFileSync(process.env.SMOKE_VITE_USED, realpathSync(fileURLToPath(import.meta.resolve('@marmeon/vite'))));

export default defineConfig({
  plugins: [marmeon({ test: true })],
  test: {
    ...(external ? { server: { deps: { external } } } : {}),
    ...(process.env.SMOKE_NATIVE === '1' ? { experimental: { viteModuleRunner: false } } : {}),
    projects: [
      { extends: true, test: { name: 'workspace', include: files.filter((file) => file !== dom), setupFiles: ['./modules/smoke/setup.ts'] } },
      ...(files.includes(dom) ? [{ extends: true, test: { name: 'dom', include: [dom], setupFiles: ['./modules/smoke/setup.ts'], environment: 'happy-dom' } }] : []),
    ],
  },
});
`;

/** The app's own setup file. Runs 2 and 3 import the virtual module in it; it boots nothing at its top level. */
const setup = (shared: boolean) => `${shared ? "import 'virtual:marmeon/test-packages';\n" : ''}(globalThis as { smokeSetup?: boolean }).smokeSetup = true;\n`;

const HEADER = `import { defineApplication, defineModule } from '@marmeon/core';
import { createTestApp } from '@marmeon/testing';
import { defineRoutes, everyone } from '@marmeon/http';
import { describe, expect, it, vi } from 'vitest';

/** Run 1 is the one without the import: the test sees another copy of every class than the app booted. */
const shared = process.env.SMOKE_SHARED === '1';
const native = process.env.SMOKE_NATIVE === '1';
// Node's own loader cannot run the app's .tsx files: with the native runner the app is defined here, with the packages only.
const application = native ? defineApplication({ root: process.cwd() }) : (await import('../../bootstrap/app.ts')).default;
`;

const INSTANCES_TEST = `${HEADER}import { BUILT, BuiltController, BuiltService, BuiltServiceProvider } from '@smoke/built';
import { KIT, KitController, KitService, KitServiceProvider } from '@smoke/kit';
import { SOURCED, SourcedController, SourcedService, SourcedServiceProvider } from '@smoke/sourced';

const routes = defineRoutes((Route) => {
  Route.authorize(everyone).get('/_smoke/kit', KitController);
  Route.authorize(everyone).get('/_smoke/sourced', SourcedController);
  Route.authorize(everyone).get('/_smoke/built', BuiltController);
});
const withRoutes = { ...application, modules: [...(application.modules ?? []), defineModule({ name: 'smoke', routes })] };

// The app is closed when its test ends.
const boot = () => createTestApp(withRoutes);

/** The identity assertion: the class the test imports is the one booted with the import, another copy of it without. */
const identity = (same: boolean) => (native ? undefined : expect(same).toBe(shared));

describe.each([
  ['a package of sources', KitServiceProvider, KIT, KitService, '/_smoke/kit', 'kit'],
  ['a package behind the source condition', SourcedServiceProvider, SOURCED, SourcedService, '/_smoke/sourced', 'sourced'],
  ['a package of built files', BuiltServiceProvider, BUILT, BuiltService, '/_smoke/built', 'built'],
] as const)('%s', (_name, Provider, Token, Service, path, value) => {
  it('boots the provider class the test imports only with the import', async () => {
    identity((await boot()).application.providers.includes(Provider));
  });

  it('binds the token the test imports only with the import', async () => {
    const app = await boot();
    if (native) return;
    if (shared) expect(app.make(Token)).toBe(value);
    else expect(() => app.make(Token)).toThrow(/\\[marmeon:K1\\]/);
  });

  it('builds the singleton of the class the test imports, with its injected parameters, only with the import', async () => {
    const app = await boot();
    if (native) return;
    // Without the import the class the test imports has an injection list only where a plugin of the app put one there (a source file, not built ones).
    if (!shared) return;
    const service = app.make(Service);
    expect(service).toBeInstanceOf(Service);
    expect(service.app).toBe(app.application);
    expect(app.make(Service)).toBe(service);
  });

  it('serves the route of its controller, which has its injection list, only with the import', async () => {
    const response = await (await boot()).get(path);
    if (native || !shared) return;
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ app: true });
  });
});

it('runs a module of the package once with the import, twice without it (a copy in each module record)', async () => {
  await boot();
  const evaluated = (globalThis as { smokeEvaluations?: Record<string, number> }).smokeEvaluations ?? {};
  if (!native) expect(evaluated.kit).toBe(shared ? 1 : 2);
});

it('takes the next import of a module that was reset as the one booted only with the import', async () => {
  const before = (await boot()).application.providers;
  expect(before.some((provider) => provider.name === 'KitServiceProvider')).toBe(true);
  vi.resetModules();
  const { KitServiceProvider: Fresh } = await import('@smoke/kit');
  if (native) return;
  expect(Fresh).not.toBe(KitServiceProvider);
  expect((await boot()).application.providers.includes(Fresh)).toBe(shared);
});

it('runs the app\\'s own setup file', () => {
  expect((globalThis as { smokeSetup?: boolean }).smokeSetup).toBe(true);
});

it('publish --check recognises the provider of the package it reads', async () => {
  const run = await (await boot()).command('publish', { args: ['@smoke/kit'], options: { check: true } });
  const said = run.lines.join('\\n');
  expect(said, said).not.toContain('does not claim');
  expect(said, said).toContain('create_kits_table');
});
`;

const DEEP_MOCK_TEST = `${HEADER}import { KIT } from '@smoke/kit';

vi.mock('@smoke/kit/greeting', () => ({ greeting: () => 'mocked' }));

it('lets the mock of a module of the package reach the provider discovery booted', async () => {
  const app = await createTestApp(application);
  expect(app.make(KIT)).toBe('mocked');
});
`;

const ENTRY_MOCK_TEST = `${HEADER}import { AUDIT, AuditServiceProvider } from '@smoke/audit';

// The factory waits and then answers with the real package: a boot that did not wait for it would see another copy.
vi.mock('@smoke/audit', async (importOriginal) => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { ...(await importOriginal<Record<string, unknown>>()) };
});

const sees = async () => {
  const app = await createTestApp(application);
  return [app.application.providers.includes(AuditServiceProvider), app.make(AUDIT)];
};

it('boots the entry its async mock factory answered with, once', async () => {
  expect(await sees()).toEqual([true, 'real']);
});

it('boots the entry its async mock factory answered with in two boots at once, never half', async () => {
  expect(await Promise.all([sees(), sees()])).toEqual([[true, 'real'], [true, 'real']]);
});
`;

const GUARD_MOCK_TEST = `${HEADER}import { AUDIT } from '@smoke/audit';

vi.mock('@smoke/guard', () => ({ charge: () => 'mocked' }));

it('lets the mock of the guard a package imports reach the package discovery booted', async () => {
  expect((await createTestApp(application)).make(AUDIT)).toBe('mocked');
});
`;

const REENTRANT_TEST = `${HEADER}
// A mock factory that boots an app imports the module it is the factory of; without importOriginal the factory has nothing to answer with.
vi.mock('@smoke/audit', async () => {
  await createTestApp((await import('../../bootstrap/app.ts')).default);
  return {};
});

it('ends with Vitest\\'s error for the export the mock lacks, not with a timeout', { timeout: 20_000 }, async () => {
  const failure = await createTestApp(application).then(() => undefined, (error: Error) => error);
  expect(failure?.message).toContain('[vitest] No "AuditServiceProvider" export is defined on the "@smoke/audit" mock.');
});
`;

// With importOriginal the inner boot of the factory runs the real module, and a boot after it gets the mock.
const REENTRANT_ORIGINAL_TEST = `${HEADER}import type { Container } from '@marmeon/core';
import { AUDIT } from '@smoke/audit';

vi.mock('@smoke/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@smoke/audit')>();
  const inner = await createTestApp((await import('../../bootstrap/app.ts')).default);
  (globalThis as { smokeInner?: unknown }).smokeInner = inner.make(actual.AUDIT);
  class Mocked extends actual.AuditServiceProvider {
    override register(container: Container): void {
      container.instance(actual.AUDIT, 'mocked');
    }
  }
  return { ...actual, AuditServiceProvider: Mocked };
});

it('runs the real module in the inner boot of the factory, and the mock in a later boot', { timeout: 20_000 }, async () => {
  expect((globalThis as { smokeInner?: unknown }).smokeInner).toBe('real');
  expect((await createTestApp(application)).make(AUDIT)).toBe('mocked');
});
`;

// A test of one package of the workspace that a project made external by its real path: Node loads it, so it is one instance, and a mock of a module
// inside it does not reach the boot (which proves it is external).
const EXTERNAL_PACKAGE_TEST = `import { createTestApp } from '@marmeon/testing';
import { defineApplication } from '@marmeon/core';
import { KIT, KitServiceProvider } from '@smoke/kit';
import { expect, it, vi } from 'vitest';

vi.mock('@smoke/kit/greeting', () => ({ greeting: () => 'mocked' }));

it('is one instance: the provider and the token the test imports are the booted ones', async () => {
  const app = await createTestApp(defineApplication({ root: process.cwd() }));
  expect(app.application.providers).toContain(KitServiceProvider);
  expect(app.make(KIT)).toBe('kit');
});

it('does not take the mock of a module inside it into the boot', async () => {
  const app = await createTestApp(defineApplication({ root: process.cwd() }));
  expect(app.make(KIT)).not.toBe('mocked');
});
`;

// Run 1 boots without a mock; with the import a mock that lacks the provider's export fails the boot, naming it (Vitest's own error: its mock answers
// for an export it was not given by throwing).
const MISSING_TEST = `${HEADER}
vi.mock('@smoke/audit', () => ({ other: 1 }));

it('fails with the missing export of a mocked package only with the import', async () => {
  if (!shared) {
    // Discovery imports the real module through Node: the mock does not reach it, and the boot goes on.
    await createTestApp(application);
    return;
  }
  const failure = await createTestApp(application).then(() => undefined, (error: Error) => error);
  expect(failure?.message).toContain('[vitest] No "AuditServiceProvider" export is defined on the "@smoke/audit" mock.');
});
`;

// A mock that has the export, as undefined: the error of discovery, with the file and the export.
const UNDEFINED_TEST = `${HEADER}
vi.mock('@smoke/audit', () => ({ AuditServiceProvider: undefined }));

it('fails with K7, naming the file and the export, for a provider the mock gives as undefined', async () => {
  const failure = await createTestApp(application).then(() => undefined, (error: Error) => error);
  expect(failure?.message).toContain('[marmeon:K7] packages/audit/src/index.ts has no export "AuditServiceProvider", which the app\\'s packages need to boot. If a test mocks it, the mock must export it.');
});
`;

const HASH_TEST = `import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { createTestApp } from '@marmeon/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

const shared = process.env.SMOKE_SHARED === '1';
const odd = join(process.cwd(), 'odd');

beforeAll(() => {
  mkdirSync(join(odd, 'app/node_modules/@smoke'), { recursive: true });
  symlinkSync(join(odd, 'pkg#odd'), join(odd, 'app/node_modules/@smoke/odd'), 'dir');
});
afterAll(() => rmSync(join(odd, 'app/node_modules'), { recursive: true, force: true }));

it('boots the package of the directory with a "#", and never the sibling its name is cut down to', async () => {
  const boot = createTestApp(defineApplication({ root: join(odd, 'app') }));
  if (shared) await expect(boot).rejects.toThrow(\`Vite resolved \${join(odd, 'pkg#odd/src/index.ts')} to \${join(odd, 'pkg#odd/src/index.ts')}, which is not that file (a "?" or "#" in a name cuts it). Rename the file.\`);
  else expect((await boot).application.providers.map((provider) => provider.name)).toContain('OddServiceProvider');
  expect((globalThis as { smokeSibling?: boolean }).smokeSibling).toBeUndefined();
});
`;

const DOM_TEST = `import { defineApplication } from '@marmeon/core';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';

// The definition is made here: the app's own is server code, which a simulated browser refuses.
it('boots the packages whose provider file the entry re-exports, in a simulated browser', async () => {
  expect(typeof document).toBe('object');
  const app = await createTestApp(defineApplication({ root: process.cwd() }));
  const names = app.application.providers.map((provider) => provider.name);
  expect(names).toEqual(expect.arrayContaining(['KitServiceProvider', 'SourcedServiceProvider', 'BuiltServiceProvider']));
});

it('keeps file: URLs in the booted provider, so its migrations and files are found', async () => {
  const app = await createTestApp(defineApplication({ root: process.cwd() }));
  const kit = app.application.providers.find((provider) => provider.name === 'KitServiceProvider') as unknown as { migrations: { from: URL } };
  expect(kit.migrations.from.protocol).toBe('file:');
});
`;

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** The environments of Vite that transformed a module of the namespace package, from the recorder's file. */
function recorded(file: string): Set<string> {
  return new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')[0]!) : []);
}

/** Every file below `dir`, as text, for what a build wrote. */
function textsBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(js|css)$/.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
}

/**
 * The package with a namespace, outside tests: the app's own plugins see its modules in `vite` (development) and in `marmeon build`,
 * and `marmeon start` serves what the build wrote. The test setup file registers nothing there.
 */
async function checkNamespacePackage(smoke: WorkspaceApp): Promise<void> {
  const { app } = smoke;
  const record = join(app, '.namespace-recorded');
  const config = join(app, 'vite.config.ts');
  const client = join(app, 'bootstrap/client.tsx');
  const [savedConfig, savedClient] = [readFileSync(config, 'utf8'), readFileSync(client, 'utf8')];
  if (!savedConfig.includes('    react(),\n')) throw new SmokeError('vite.config.ts of the kit has no "    react()," line to put the recorder after.');
  rmSync(record, { force: true });
  try {
    writeFileSync(config, `import { appendFileSync } from 'node:fs';\n${savedConfig.replace('    react(),\n', `    react(),\n${RECORDER}`)}`);
    writeFileSync(client, `${savedClient}\nimport { MARK } from '@smoke/ui/components';\nconsole.info(MARK);\n`);
    const env = { SMOKE_RECORD: record, NODE_OPTIONS: '' };

    // development: the dev server transforms the client entry and, when asked, the package's module
    const port = await freePort();
    const vite = spawn(join(app, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: app, env: { ...smoke.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    vite.stdout.on('data', (chunk) => (output += chunk));
    vite.stderr.on('data', (chunk) => (output += chunk));
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (vite.exitCode !== null) throw new SmokeError(`vite ended with ${vite.exitCode}:\n${output}`);
        if (Date.now() > deadline) throw new SmokeError(`the dev server did not answer within 30 s:\n${output}`);
        try {
          if ((await fetch(`http://127.0.0.1:${port}/bootstrap/client.tsx`, { signal: AbortSignal.timeout(2_000) })).ok) break;
        } catch {
          // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const served = await fetch(`http://127.0.0.1:${port}/packages/ui/src/components.ts`);
      if (!(await served.text()).includes('smoke-ui-component')) throw new SmokeError(`the dev server did not serve the module of the namespace package (${served.status}):\n${output}`);
    } finally {
      vite.kill();
    }
    if (!recorded(record).has('client')) throw new SmokeError('the plugins of the app did not see the namespace package in the dev server.');

    // build and start
    rmSync(record, { force: true });
    smoke.run(join(app, 'node_modules/.bin/marmeon'), ['build'], env);
    if (!recorded(record).has('client')) throw new SmokeError('the plugins of the app did not see the namespace package in marmeon build.');
    if (!textsBelow(join(app, 'dist/client')).some((text) => text.includes('smoke-ui-component'))) throw new SmokeError('marmeon build wrote no module of the namespace package into dist/client.');
    await smoke.serve('/login');
  } finally {
    writeFileSync(config, savedConfig);
    writeFileSync(client, savedClient);
    rmSync(record, { force: true });
  }
}

/**
 * `@marmeon/vite` as a store outside the project holds it: its files in a folder next to the app (so outside the app's workspace root), its
 * dependencies beside it as links to the very copies the app uses. Returns the package's folder.
 */
function vitePackageOutside(app: string): string {
  const real = realpathSync(join(app, 'node_modules/@marmeon/vite'));
  const siblings = dirname(dirname(real)); // the `node_modules` the package's own dependencies are in
  const target = join(dirname(app), 'outside-vite/node_modules');
  rmSync(dirname(target), { recursive: true, force: true });
  mkdirSync(join(target, '@marmeon'), { recursive: true });
  cpSync(real, join(target, '@marmeon/vite'), { recursive: true });
  for (const entry of readdirSync(siblings, { withFileTypes: true })) {
    const names = entry.name.startsWith('@') ? readdirSync(join(siblings, entry.name)).map((name) => `${entry.name}/${name}`) : [entry.name];
    for (const name of names.filter((name) => name !== '@marmeon/vite')) {
      mkdirSync(dirname(join(target, name)), { recursive: true });
      symlinkSync(realpathSync(join(siblings, name)), join(target, name));
    }
  }
  return join(target, '@marmeon/vite');
}

/** The runs of `checkWorkspacePackages`; a driver may ask for some of them. */
export type WorkspaceRun = 'plain' | 'plain-deps-external' | 'native' | 'shared' | 'shared-deps-external' | 'shared-package-external' | 'shared-linked';

const ALL_RUNS: readonly WorkspaceRun[] = ['plain', 'plain-deps-external', 'native', 'shared', 'shared-deps-external', 'shared-package-external', 'shared-linked'];

/**
 * Lays the packages and the tests on the smoke app, runs them through `marmeon({ test: true })` as described at the top, and takes everything
 * away again (`package.json`, the lockfile and `node_modules` as they were). A red test is a `SmokeError` with Vitest's output.
 */
export async function checkWorkspacePackages(smoke: WorkspaceApp, installFlags: readonly string[], options: { runs?: readonly WorkspaceRun[]; namespace?: boolean } = {}): Promise<void> {
  const { app } = smoke;
  const runs = options.runs ?? ALL_RUNS;
  const saved = ['package.json', 'pnpm-lock.yaml'].map((file) => [file, readFileSync(join(app, file), 'utf8')] as const);
  const install = (...args: string[]) => smoke.run('pnpm', [...args, ...installFlags, '--reporter', 'append-only']);
  /** One run of Vitest over exactly `files`: every file passed, and Vitest says so with the number of them. */
  const vitest = (shared: boolean, files: readonly string[], env: NodeJS.ProcessEnv = {}) => {
    write(app, { 'modules/smoke/setup.ts': setup(shared) });
    const output = smoke.run(join(app, 'node_modules/.bin/vitest'), ['run', '--config', 'vitest.workspace.config.ts', '--reporter=verbose', '--maxWorkers=2'], { SMOKE_SHARED: shared ? '1' : '0', SMOKE_FILES: files.join(','), ...env });
    const passed = new RegExp(`Test Files\\s+${files.length} passed \\(${files.length}\\)`).test(output) && /Tests\s+\d+ passed/.test(output) && !/Tests\s+.*\d+ failed/.test(output);
    const missing = files.filter((file) => !output.includes(`modules/smoke/${file}.test.ts`));
    if (!passed || missing.length > 0) throw new SmokeError(`vitest did not pass the ${files.length} files of the workspace packages${missing.length > 0 ? ` (no ${missing.join(', ')})` : ''}:\n${output}`);
    return output;
  };
  const every = ['dom', ...PLAIN_TESTS];
  const shared = [...every, 'deep-mock', 'entry-mock', 'guard-mock', 'reentrant', 'reentrant-original', 'undefined-export'];
  /** The setup file of the shared runs type checks, and a named import of the virtual module is exactly one error, TS2305 (it has no exports). */
  const typeCheck = () => {
    write(app, {
      'modules/smoke/named.ts': "import { nothing } from 'virtual:marmeon/test-packages';\n\nexport { nothing };\n",
      'modules/smoke/tsconfig.probe.json': `${JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { noEmit: true }, include: ['setup.ts'] })}\n`,
      'modules/smoke/tsconfig.named.json': `${JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { noEmit: true }, include: ['named.ts'] })}\n`,
    });
    const tsc = join(app, 'node_modules/.bin/tsc');
    smoke.run(tsc, ['-p', 'modules/smoke/tsconfig.probe.json']);
    let named = '';
    try {
      smoke.run(tsc, ['-p', 'modules/smoke/tsconfig.named.json']);
    } catch (error) {
      named = (error as Error).message;
    }
    const codes = [...named.matchAll(/error (TS\d+)/g)].map((match) => match[1]);
    if (codes.join() !== 'TS2305') throw new SmokeError(`a named import of virtual:marmeon/test-packages should be exactly one TS2305, tsc said:\n${named}`);
  };
  try {
    write(app, Object.fromEntries([['kit', KIT], ['sourced', SOURCED], ['built', BUILT], ['guard', GUARD], ['audit', AUDIT], ['ui', UI]].flatMap(([name, files]) => Object.entries(files as Record<string, string>).map(([p, t]) => [`packages/${name as string}/${p}`, t]))));
    install('add', ...['kit', 'sourced', 'built', 'guard', 'audit', 'ui'].map((name) => `link:./packages/${name}`));
    install('add', '-D', 'happy-dom@^21.0.4', 'vitest@^5.1.1');
    write(app, {
      ...ODD,
      'vitest.workspace.config.ts': VITEST_CONFIG,
      'modules/smoke/instances.test.ts': INSTANCES_TEST,
      'modules/smoke/missing.test.ts': MISSING_TEST,
      'modules/smoke/hash.test.ts': HASH_TEST,
      'modules/smoke/dom.test.ts': DOM_TEST,
      'modules/smoke/deep-mock.test.ts': DEEP_MOCK_TEST,
      'modules/smoke/entry-mock.test.ts': ENTRY_MOCK_TEST,
      'modules/smoke/guard-mock.test.ts': GUARD_MOCK_TEST,
      'modules/smoke/reentrant.test.ts': REENTRANT_TEST,
      'modules/smoke/reentrant-original.test.ts': REENTRANT_ORIGINAL_TEST,
      'modules/smoke/external-package.test.ts': EXTERNAL_PACKAGE_TEST,
      'modules/smoke/undefined-export.test.ts': UNDEFINED_TEST,
    });
    // A failing test fails the command, and `run` throws with Vitest's output.
    for (const run of ALL_RUNS.filter((name) => runs.includes(name))) {
      if (run === 'plain') vitest(false, every);
      if (run === 'plain-deps-external') vitest(false, every, { SMOKE_EXTERNAL: 'deps' });
      if (run === 'native') vitest(false, every, { SMOKE_NATIVE: '1' });
      if (run === 'shared') {
        vitest(true, shared);
        typeCheck();
      }
      if (run === 'shared-deps-external') vitest(true, shared, { SMOKE_EXTERNAL: 'deps' });
      if (run === 'shared-package-external') vitest(true, ['external-package'], { SMOKE_EXTERNAL: 'package' });
      if (run === 'shared-linked') {
        // The app's `overrides` pin @marmeon/vite to its tarball, so the link is made by hand, and put back after the run.
        const outside = vitePackageOutside(app);
        const link = join(app, 'node_modules/@marmeon/vite');
        const original = readlinkSync(link);
        const used = join(dirname(app), 'vite-used');
        rmSync(link);
        symlinkSync(outside, link, 'dir');
        try {
          vitest(true, shared, { SMOKE_VITE_USED: used });
          const seen = readFileSync(used, 'utf8').trim();
          if (seen !== realpathSync(join(outside, 'dist/index.js'))) throw new SmokeError(`the run with @marmeon/vite linked from outside used ${seen}, not ${outside}.`);
        } finally {
          rmSync(link);
          symlinkSync(original, link, 'dir');
          rmSync(used, { force: true });
        }
      }
    }
    if (options.namespace !== false) await checkNamespacePackage(smoke);
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError(`the app's tests with the packages of its workspace: ${(error as Error).message}`);
  } finally {
    for (const [file, text] of saved) writeFileSync(join(app, file), text);
    for (const path of ['packages', 'modules/smoke', 'odd', 'vitest.workspace.config.ts']) rmSync(join(app, path), { recursive: true, force: true });
  }
  install('install', '--frozen-lockfile');
}
