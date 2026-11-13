import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon } from './plugin.ts';

// What an app that shadows a module of a package relies on: the modules of a package with a namespace pass through every plugin of the
// app — in development (client and server rendering) and in the build. The package is the compiled one of fixtures/status-board, installed
// in the app's node_modules as a published package is; the app's plugin answers the import of its `./Badge.js` with a module of the app.

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));
const fixture = join(repo, 'fixtures/status-board');

/** What the app's module renders in the place of the package's badge; the package's own renders an element with `data-badge`. */
const SHADOW = 'shadowed-badge';
const ORIGINAL = 'data-badge';

/** Whether an import is the package's own import of its badge. */
function replaces(source: string, importer: string | undefined): boolean {
  return source === './Badge.js' && importer?.replaceAll('\\', '/').includes('/@fixtures/status-board/') === true;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** An app outside the workspace with the compiled fixture in its `node_modules` and a plugin of its own that replaces the package's badge. */
function shadowingApp(): string {
  if (!existsSync(join(fixture, 'dist/StatusBoard.js'))) throw new Error('fixtures/status-board is not built: run pnpm build first.');
  // The real path: the dev server compares the files it serves with the root as spelled.
  const root = realpathSync(tempDir('marmeon-vite-shadow-'));
  write(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: { '@fixtures/status-board': '*', '@marmeon/react': '*' } }),
    'index.html': '<!doctype html><html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>',
    // Both entries render the component to a string: the markup it makes shows which badge it was given.
    'bootstrap/client.ts': "import { StatusBoard } from '@fixtures/status-board/components';\ndocument.title = JSON.stringify(StatusBoard({ services: [{ name: 'Web', state: 'up' }] }));\n",
    'bootstrap/ssr.ts': "import { StatusBoard } from '@fixtures/status-board/components';\nexport const render = async () => ({ html: JSON.stringify(StatusBoard({ services: [{ name: 'Web', state: 'up' }] })) });\n",
    '.marmeon/routes.json': JSON.stringify({ version: 1, routes: { 'auth.sensitive': { method: 'get', path: '/settings/sensitive' } }, hidden: {} }),
    'shadow/Badge.js': `export const Badge = ({ state }) => '${SHADOW}:' + state;\n`,
    'node_modules/@marmeon/react/package.json': JSON.stringify({ name: '@marmeon/react', type: 'module', exports: './index.js' }),
    'node_modules/@marmeon/react/index.js': 'export const Link = () => null;\n',
    'node_modules/react/package.json': JSON.stringify({ name: 'react', type: 'module', exports: { './jsx-runtime': './jsx-runtime.js' } }),
    // Function components are called, so a component's markup is one tree of plain objects and strings.
    'node_modules/react/jsx-runtime.js': [
      'const make = (type, props) => (typeof type === "function" ? type(props) : { type, props });',
      'export const jsx = make;',
      'export const jsxs = make;',
      '',
    ].join('\n'),
    'vite.config.ts': [
      "import { fileURLToPath } from 'node:url';",
      "import { marmeon } from '@marmeon/vite';",
      "const shadow = fileURLToPath(new URL('./shadow/Badge.js', import.meta.url));",
      'export default {',
      '  plugins: [',
      "    marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' } }),",
      // The plugin of the app: the package's import of its own badge goes to the app's module.
      "    { name: 'app:shadow', enforce: 'pre', resolveId(source, importer) { if (source === './Badge.js' && importer?.replaceAll('\\\\', '/').includes('/@fixtures/status-board/')) return shadow; } },",
      '  ],',
      '};',
      '',
    ].join('\n'),
  });
  // The package as published: its package.json as `pnpm pack` writes it (the `publishConfig` exports, without the source condition) and
  // what the build made, nothing of its source. Only its components: the app has no use for the package's area here, and the area's
  // entry, pages and texts would be built with it.
  const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')) as { publishConfig: { exports: Record<string, unknown> } };
  write(root, {
    'node_modules/@fixtures/status-board/package.json': JSON.stringify({ name: '@fixtures/status-board', type: 'module', sideEffects: ['**/*.css'], exports: { './components': manifest.publishConfig.exports['./components'] }, marmeon: { namespace: 'status' } }),
  });
  cpSync(join(fixture, 'dist'), join(root, 'node_modules/@fixtures/status-board/dist'), { recursive: true });
  symlinkSync(vitePackage, join(root, 'node_modules/vite'), 'dir');
  symlinkSync(join(repo, 'packages/vite'), join(root, 'node_modules/@marmeon/vite'), 'dir');
  return root;
}

const files = (dir: string, extension: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith(extension))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');

let server: ViteDevServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/**
 * The dev server of the app, with the plugin from this checkout (the config file would load the package's build) and the app's plugin
 * of the config file's text.
 */
async function serve(root: string): Promise<ViteDevServer> {
  const shadow = join(root, 'shadow/Badge.js');
  const appPlugin: Plugin = { name: 'app:shadow', enforce: 'pre', resolveId: (source, importer) => (replaces(source, importer) ? shadow : undefined) };
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' } }), appPlugin],
    server: { port: 0, host: '127.0.0.1', hmr: false, ws: false },
  });
  await server.listen();
  return server;
}

/** The import specifiers of module code the dev server made — the URLs the browser would request next. */
const importsOf = (code: string) => [...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(([, url]) => url!);

/** What the browser is served for the client entry and for every module of the package or the app it reaches. */
async function clientModules(dev: ViteDevServer): Promise<string> {
  const seen = new Set<string>();
  const codes: string[] = [];
  const queue = ['/bootstrap/client.ts'];
  while (queue.length > 0 && seen.size < 40) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const result = await dev.transformRequest(url);
    if (!result) continue;
    codes.push(result.code);
    // The package and the app's module; nothing of the stubs' own dependencies matters.
    queue.push(...importsOf(result.code).filter((specifier) => /status-board|shadow/.test(specifier)));
  }
  return codes.join('\n');
}

describe('an app plugin that replaces a module of an installed package with a namespace', () => {
  it('is asked in development: the browser is served the app\'s module, not the package\'s own', async () => {
    const dev = await serve(shadowingApp());
    const served = await clientModules(dev);
    expect(served).toContain(SHADOW);
    expect(served).not.toContain(ORIGINAL);
  }, 60_000);

  it('is asked in server rendering in development: the module that renders on the server is the app\'s', async () => {
    const dev = await serve(shadowingApp());
    const ssr = (await dev.ssrLoadModule('/bootstrap/ssr.ts')) as { render(): Promise<{ html: string }> };
    const { html } = await ssr.render();
    expect(html).toContain(SHADOW);
    expect(html).not.toContain(ORIGINAL);
  }, 60_000);

  it('is asked in the production build: the client bundle holds the app\'s module and the server bundle runs it', () => {
    const root = shadowingApp();
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV' || key === 'NODE_OPTIONS') delete env[key];
    const built = spawnSync(process.execPath, [join(repo, 'packages/cli/bin/marmeon.js'), 'build', '--no-typecheck'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    expect(`${built.stdout}${built.stderr}`).toContain('Built dist/client and dist/server');
    expect(built.status).toBe(0);

    const client = files(join(root, 'dist/client'), '.js');
    expect(client).toContain(SHADOW);
    expect(client).not.toContain(ORIGINAL);

    const server = files(join(root, 'dist/server'), '.js');
    expect(server).toContain(SHADOW);
    expect(server).not.toContain(ORIGINAL);
    // Run as `marmeon start` runs it: the package is in the bundle, not left for Node to load (its stylesheet import would stop Node).
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', `const { render } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/server/ssr.js')).href)}); console.log((await render()).html);`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(ran.stdout).toContain(SHADOW);
    expect(ran.stdout).not.toContain(ORIGINAL);
  }, 90_000);
});
