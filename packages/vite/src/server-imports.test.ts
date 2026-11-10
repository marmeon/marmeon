import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer, isRunnableDevEnvironment, type ViteDevServer } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { marmeon, type MarmeonOptions } from './plugin.ts';
import { valueImports } from './server-imports.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const temporary: string[] = [];
const servers: ViteDevServer[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const CONTROLLER = "export class ShowHomeController {\n  handle() {\n    return 'server-only-secret';\n  }\n}\n";

/** A tiny app: a controller (server code) and a page; `files` overrides or adds. */
function app(files: Record<string, string>): string {
  const root = realpathSync(tempDir('marmeon-server-imports-'));
  temporary.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'bootstrap/client.ts': "import pages from 'virtual:marmeon/pages';\nfor (const load of Object.values(pages)) void load();\n",
    'bootstrap/ssr.ts': "import { ShowHomeController } from '../modules/demo/controllers/ShowHomeController.ts';\nexport const render = () => new ShowHomeController().handle();\n",
    'modules/demo/controllers/ShowHomeController.ts': CONTROLLER,
    'modules/demo/views/Home.tsx': "import type { ShowHomeController } from '../controllers/ShowHomeController.ts';\nexport default (props: ReturnType<ShowHomeController['handle']>) => props;\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

async function serve(root: string, options: MarmeonOptions = {}): Promise<ViteDevServer> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' }, ...options }),
  });
  servers.push(server);
  return server;
}

/** Loads a module as SSR does (and Vitest with `marmeon({ test: true })`): through the server environment's runner. */
function ssrImport(server: ViteDevServer, path: string): Promise<unknown> {
  const ssr = server.environments.ssr!;
  if (!isRunnableDevEnvironment(ssr)) throw new Error('not runnable');
  return ssr.runner.import(path);
}

const message = (error: unknown) => (error as Error).message;
const DIRECT =
  "[marmeon] modules/demo/views/Home.tsx:1:1 — imports modules/demo/controllers/ShowHomeController.ts as a value: a controller is server code, and a value import bundles it — with everything it imports — into the browser. A class is a value even where only its type is used: write import type { ShowHomeController } from '../controllers/ShowHomeController.ts'. If the browser needs a value from it, move that value into a module both sides import.";

describe('valueImports()', () => {
  it('finds what loads a module at runtime — not import type, export type or a typeof import()', () => {
    const code = [
      "import type { A } from './a.ts';",
      "import { type B } from './b.ts';",
      "import C, { D, type E } from './c.ts';",
      "import './side.ts';",
      "export type { F } from './f.ts';",
      "export { G } from './g.ts';",
      "export * from './h.ts';",
      "export type * from './i.ts';",
      "const lazy = () => import('./j.ts');",
      "type K = typeof import('./k.ts');",
      'const computed = (name: string) => import(name);',
    ].join('\n');
    expect(valueImports(code, 'x.ts').map((found) => `${found.line}:${found.column} ${found.specifier}`)).toEqual([
      '2:1 ./b.ts',
      '3:1 ./c.ts',
      '4:1 ./side.ts',
      '6:1 ./g.ts',
      '7:1 ./h.ts',
      '9:20 ./j.ts',
    ]);
    const hints = valueImports(code, 'x.ts').map((found) => found.hint);
    expect(hints[0]).toContain("`import { type … }` still loads the module (verbatimModuleSyntax keeps it as `import {} from …`): write import type { B } from './b.ts'.");
    // A default and named ones need two type imports.
    expect(hints[1]).toContain("write import type C from './c.ts'; import type { D, E } from './c.ts'.");
    expect(hints[2]).toContain('side effects only');
    expect(hints[3]).toContain("export type { … } from './g.ts'");
    expect(hints[5]).toContain('import() loads it in the browser');
  });
});

describe('server imports while serving', () => {
  it('fails a page that imports a controller as a value — in the browser environment (the overlay shows it)', async () => {
    const root = app({ 'modules/demo/views/Home.tsx': "import { ShowHomeController } from '../controllers/ShowHomeController.ts';\nexport default (props: ReturnType<ShowHomeController['handle']>) => props;\n" });
    const server = await serve(root);
    const error = await server.environments.client!.transformRequest('/modules/demo/views/Home.tsx').catch((caught: unknown) => caught);
    expect(message(error)).toBe(DIRECT);
    expect((error as { plugin?: string }).plugin).toBe('marmeon:server-imports');
  });

  it('lets import type and type re-exports through, and server code import anything', async () => {
    const root = app({ 'modules/demo/views/Types.tsx': "export type { ShowHomeController } from '../controllers/ShowHomeController.ts';\nexport type * from '../controllers/ShowHomeController.ts';\n" });
    const server = await serve(root);
    await expect(server.environments.client!.transformRequest('/modules/demo/views/Home.tsx')).resolves.toBeTruthy();
    await expect(server.environments.client!.transformRequest('/modules/demo/views/Types.tsx')).resolves.toBeTruthy();
    // The SSR entry is server code: it may import the controller.
    await expect(ssrImport(server, '/bootstrap/ssr.ts')).resolves.toBeTruthy();
  });

  it('follows client code into the modules it imports: view → helper → controller names the helper and the chain', async () => {
    const root = app({
      'modules/demo/helpers.ts': "import { ShowHomeController } from './controllers/ShowHomeController.ts';\nexport const label = () => ShowHomeController.name;\n",
      'modules/demo/views/Home.tsx': "import { label } from '../helpers.ts';\nexport default () => label();\n",
    });
    const server = await serve(root);
    await server.environments.client!.transformRequest('/modules/demo/views/Home.tsx');
    const error = await server.environments.client!.transformRequest('/modules/demo/helpers.ts').catch((caught: unknown) => caught);
    expect(message(error)).toContain(
      '[marmeon] modules/demo/helpers.ts:1:1 — imports modules/demo/controllers/ShowHomeController.ts as a value (modules/demo/helpers.ts is client code: modules/demo/views/Home.tsx → modules/demo/helpers.ts): a controller is server code',
    );
  });

  it('checks pages in server environments too (SSR, tests with marmeon({ test: true })) — also through modules loaded before as server code', async () => {
    const files = {
      'modules/demo/helpers.ts': "import { ShowHomeController } from './controllers/ShowHomeController.ts';\nexport const label = () => ShowHomeController.name;\n",
      'modules/demo/views/Home.tsx': "import { label } from '../helpers.ts';\nexport default () => label();\n",
    };
    for (const test of [false, true]) {
      const server = await serve(app(files), { test });
      await expect(ssrImport(server, '/modules/demo/views/Home.tsx')).rejects.toThrow('[marmeon] modules/demo/helpers.ts:1:1 — imports modules/demo/controllers/ShowHomeController.ts as a value');

      // The helper is server code first (a controller's import): fine. A page that imports it later fails all the same.
      const later = await serve(app(files), { test });
      await expect(ssrImport(later, '/modules/demo/helpers.ts')).resolves.toBeTruthy();
      await expect(ssrImport(later, '/modules/demo/views/Home.tsx')).rejects.toThrow('(modules/demo/helpers.ts is client code: modules/demo/views/Home.tsx → modules/demo/helpers.ts)');
    }
  });

  it('lets a test beside a page import a controller in a server environment — unless a page imports the test', async () => {
    const test = "import { ShowHomeController } from '../controllers/ShowHomeController.ts';\nexport const name = ShowHomeController.name;\n";
    const tests = { 'modules/demo/views/Home.test.tsx': test, 'modules/demo/views/Home.spec.tsx': test, 'modules/demo/views/Home.type-test.tsx': test };
    const server = await serve(app(tests), { test: true });
    for (const file of Object.keys(tests)) await expect(ssrImport(server, `/${file}`), file).resolves.toBeTruthy();

    const imported = await serve(app({ ...tests, 'modules/demo/views/Home.tsx': "import { name } from './Home.spec.tsx';\nexport default () => name;\n" }), { test: true });
    await expect(ssrImport(imported, '/modules/demo/views/Home.tsx')).rejects.toThrow(
      '(modules/demo/views/Home.spec.tsx is client code: modules/demo/views/Home.tsx → modules/demo/views/Home.spec.tsx)',
    );
  });

  it('takes more server modules from marmeon({ serverModules }) — and fewer with !glob', async () => {
    const root = app({
      'modules/demo/services/Billing.ts': "export const billing = 'server-only';\n",
      'modules/demo/jobs/labels.ts': "export const labels = ['shared'];\n",
      'modules/demo/views/Home.tsx': "import { billing } from '../services/Billing.ts';\nimport { labels } from '../jobs/labels.ts';\nexport default () => [billing, labels];\n",
    });
    const plain = await serve(root);
    const error = await plain.environments.client!.transformRequest('/modules/demo/views/Home.tsx').catch((caught: unknown) => caught);
    expect(message(error)).toContain('modules/demo/views/Home.tsx:2:1 — imports modules/demo/jobs/labels.ts as a value: a job is server code');
    expect(message(error)).not.toContain('Billing');

    const configured = await serve(root, { serverModules: ['modules/*/services/**', '!modules/demo/jobs/labels.ts'] });
    const other = await configured.environments.client!.transformRequest('/modules/demo/views/Home.tsx').catch((caught: unknown) => caught);
    expect(message(other)).toContain('modules/demo/views/Home.tsx:1:1 — imports modules/demo/services/Billing.ts as a value: a module matching modules/*/services/** is server code');
    expect(message(other)).not.toContain('labels.ts');
  });

  it('takes the server folders package.json declares — in the browser environment and in tests (test: true) — and honours import type and !glob', async () => {
    const declared = ['modules/*/invoices/**', '!modules/demo/jobs/labels.ts'];
    const root = app({
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', marmeon: { serverModules: declared } }),
      'modules/demo/invoices/Ctl.ts': "export const invoice = 'server-only';\n",
      'modules/demo/jobs/labels.ts': "export const labels = ['shared'];\n",
      'modules/demo/views/Home.tsx': "import { invoice } from '../invoices/Ctl.ts';\nexport default () => invoice;\n",
      'modules/demo/views/Labels.tsx': "import { labels } from '../jobs/labels.ts';\nexport default () => labels;\n",
      'modules/demo/views/Typed.tsx': "import type { invoice } from '../invoices/Ctl.ts';\nexport default (value?: typeof invoice) => value;\n",
    });
    const wanted = 'imports modules/demo/invoices/Ctl.ts as a value: a module of package.json\'s "serverModules" (modules/*/invoices/**) is server code';
    const browser = await serve(root);
    const error = await browser.environments.client!.transformRequest('/modules/demo/views/Home.tsx').catch((caught: unknown) => caught);
    expect(message(error)).toContain(wanted);
    await expect(browser.environments.client!.transformRequest('/modules/demo/views/Labels.tsx')).resolves.toBeTruthy();
    await expect(browser.environments.client!.transformRequest('/modules/demo/views/Typed.tsx')).resolves.toBeTruthy();

    const testing = await serve(root, { test: true });
    await expect(ssrImport(testing, '/modules/demo/views/Home.tsx')).rejects.toThrow(wanted);
    await expect(ssrImport(testing, '/modules/demo/views/Typed.tsx')).resolves.toBeTruthy();
    await expect(ssrImport(testing, '/modules/demo/views/Labels.tsx')).resolves.toBeTruthy();
  });

  it('adds the declaration and the option: both patterns apply', async () => {
    const root = app({
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', marmeon: { serverModules: ['modules/*/invoices/**'] } }),
      'modules/demo/invoices/Ctl.ts': "export const invoice = 'a';\n",
      'modules/demo/services/Billing.ts': "export const billing = 'b';\n",
      'modules/demo/views/A.tsx': "import { invoice } from '../invoices/Ctl.ts';\nexport default () => invoice;\n",
      'modules/demo/views/B.tsx': "import { billing } from '../services/Billing.ts';\nexport default () => billing;\n",
    });
    const server = await serve(root, { serverModules: ['modules/*/services/**'] });
    const a = await server.environments.client!.transformRequest('/modules/demo/views/A.tsx').catch((caught: unknown) => caught);
    const b = await server.environments.client!.transformRequest('/modules/demo/views/B.tsx').catch((caught: unknown) => caught);
    expect(message(a)).toContain('a module of package.json\'s "serverModules" (modules/*/invoices/**) is server code');
    expect(message(b)).toContain('a module matching modules/*/services/** is server code');
  });

  it('stops the server, in every mode, for a broken declaration (H14)', async () => {
    const invalid = app({ 'package.json': '{ "marmeon": nonsense' });
    await expect(serve(invalid)).rejects.toThrow('[marmeon:H14] package.json: is not valid JSON');
    await expect(serve(invalid, { test: true })).rejects.toThrow('[marmeon:H14]');
    const typo = app({ 'package.json': JSON.stringify({ name: 'fixture', marmeon: { serverModules: 'x' } }) });
    await expect(serve(typo)).rejects.toThrow('[marmeon:H14] package.json: "marmeon"."serverModules" is not a list of globs');
    await expect(serve(typo, { test: true })).rejects.toThrow('[marmeon:H14]');
  });

  it('refuses a value import of @marmeon/mail or @marmeon/react/mail in client code — and lets import type through', async () => {
    for (const specifier of ['@marmeon/mail', '@marmeon/react/mail']) {
      const root = app({ 'modules/demo/views/Home.tsx': `import { toMjml } from '${specifier}';\nexport default () => toMjml;\n` });
      const server = await serve(root);
      const error = await server.environments.client!.transformRequest('/modules/demo/views/Home.tsx').catch((caught: unknown) => caught);
      expect(message(error)).toContain(`[marmeon] modules/demo/views/Home.tsx:1:1 — imports ${specifier} as a value: the mail package is server code`);
      expect(message(error)).toContain('A mail is composed on the server: render it in modules/<module>/mail/');

      const types = app({ 'modules/demo/views/Home.tsx': `import type { Mailable } from '${specifier}';\nexport type { Mailable } from '${specifier}';\nexport default (props: Mailable) => props;\n` });
      await expect((await serve(types)).environments.client!.transformRequest('/modules/demo/views/Home.tsx')).resolves.toBeTruthy();
    }
  });

  it('refuses the mail packages behind a helper that a page imports, and in a server environment too', async () => {
    const files = {
      'modules/demo/helpers.ts': "import { Mailer } from '@marmeon/mail';\nexport const label = () => Mailer.name;\n",
      'modules/demo/views/Home.tsx': "import { label } from '../helpers.ts';\nexport default () => label();\n",
    };
    const server = await serve(app(files), { test: true });
    await expect(ssrImport(server, '/modules/demo/views/Home.tsx')).rejects.toThrow('[marmeon] modules/demo/helpers.ts:1:1 — imports @marmeon/mail as a value');
  });
});
