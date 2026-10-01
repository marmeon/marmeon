import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));
const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/**
 * A minimal app outside the workspace: no UI adapter (the plugin is UI-agnostic), and one framework
 * package whose `@bespokecore/source` condition points at different code than its build.
 */
function app({ vite = true, plugin = true, typescript }: { vite?: boolean; plugin?: boolean; typescript?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bespoke-vite-'));
  temporary.push(root);
  write(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: { '@bespokecore/fake': '*' } }),
    'index.html': '<!doctype html><html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>',
    'bootstrap/client.ts': [
      "import { origin } from '@bespokecore/fake';",
      "import pages from 'virtual:bespoke/pages';",
      "if (import.meta.env.DEV) console.log('development only');",
      'document.title = `${origin} ${Object.keys(pages).join(",")}`;',
      "for (const load of Object.values(pages)) void load();",
    ].join('\n'),
    'bootstrap/ssr.ts': "import { origin } from '@bespokecore/fake';\nexport const render = async () => ({ html: origin });\n",
    'modules/demo/views/Home.ts': "export default 'home page';\n",
    'node_modules/@bespokecore/fake/package.json': JSON.stringify({
      name: '@bespokecore/fake',
      type: 'module',
      exports: { '.': { '@bespokecore/source': './src/index.js', default: './dist/index.js' } },
    }),
    'node_modules/@bespokecore/fake/src/index.js': "export const origin = 'from-src';\n",
    'node_modules/@bespokecore/fake/dist/index.js': "export const origin = 'from-dist';\n",
    'vite.config.ts': plugin
      ? [
          "import { bespoke } from '@bespokecore/vite';",
          "export default { plugins: [bespoke({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' }, pages: 'modules/*/views/**/*.ts' })] };",
        ].join('\n')
      : 'export default {};',
  });
  if (vite) {
    symlinkSync(vitePackage, join(root, 'node_modules/vite'), 'dir');
    symlinkSync(join(repo, 'packages/vite'), join(root, 'node_modules/@bespokecore/vite'), 'dir');
  }
  if (typescript !== undefined) {
    // An app with its own TypeScript: `bespoke build` type-checks `modules/` first.
    symlinkSync(realpathSync(join(repo, 'node_modules/typescript')), join(root, 'node_modules/typescript'), 'dir');
    write(root, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'nodenext', types: [] }, include: ['modules/**/*.ts'] }),
      'modules/demo/total.ts': typescript,
    });
  }
  return root;
}

/** `bespoke build` as an app runs it: a fresh process, no test environment. */
function build(root: string, ...args: string[]): { code: number | null; out: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV' || key === 'NODE_OPTIONS') delete env[key];
  const result = spawnSync(process.execPath, [join(repo, 'packages/cli/bin/bespoke.js'), 'build', ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const bundle = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');

describe('bespoke build with the bespoke() plugin', () => {
  it('never resolves the source condition, builds for production, and writes both bundles where the server looks', async () => {
    const root = app();
    const { code, out } = build(root);
    expect(out).toContain('Built dist/client and dist/server');
    expect(code).toBe(0);

    const client = bundle(join(root, 'dist/client'));
    const server = bundle(join(root, 'dist/server'));
    // The source condition is for serving inside the monorepo only: a build takes what a published package ships.
    expect(client).toContain('from-dist');
    expect(`${client}${server}`).not.toContain('from-src');
    expect(`${client}${server}`).not.toMatch(/@bespokecore\/fake\/src\//);
    // A production build (`resolveConfig` must not leave NODE_ENV=development behind).
    expect(client).not.toContain('development only');

    // The client entry comes from the plugin, not from index.html.
    // `async`: a streamed page hydrates its shell while the rest still arrives.
    expect(readFileSync(join(root, 'dist/client/index.html'), 'utf8')).toMatch(/<script type="module" async crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);
    // virtual:bespoke/pages: root-absolute keys, one chunk per page.
    expect(client).toContain('/modules/demo/views/Home.ts');
    expect(readdirSync(join(root, 'dist/client/assets')).some((file) => file.startsWith('Home-'))).toBe(true);

    // The overridden SSR entry still lands at dist/server/ssr.js, and runs as `bespoke start` runs it (no source condition).
    const ssr = spawnSync(process.execPath, ['--input-type=module', '-e', `const { render } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/server/ssr.js')).href)}); console.log((await render()).html);`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(ssr.stdout.trim()).toBe('from-dist');
  }, 60_000);

  it('type-checks the app first, like next build: a type error fails the build and is printed; --no-typecheck builds anyway', () => {
    const root = app({ typescript: "export const total: number = 'forty-two';\n" });
    const failed = build(root);
    expect(failed.out).toContain("modules/demo/total.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(failed.out).toContain('Not built: 1 type error in 1 file (tsc --noEmit). Fix them — or build anyway with --no-typecheck.');
    expect(failed.out).not.toContain('Built dist/client');
    expect(failed.code).toBe(1);

    const skipped = build(root, '--no-typecheck');
    expect(skipped.out).toContain('Built dist/client and dist/server');
    expect(skipped.code).toBe(0);

    writeFileSync(join(root, 'modules/demo/total.ts'), 'export const total: number = 42;\n');
    const passed = build(root);
    expect(passed.out).toContain('✓ Type-checked the app');
    expect(passed.code).toBe(0);
  }, 60_000);

  it('says how to install Vite when the app has none', () => {
    const { code, out } = build(app({ vite: false }));
    expect(out).toContain('Vite is not installed in this app. `bespoke dev` and `bespoke build` need it: pnpm add -D vite @bespokecore/vite');
    expect(code).toBe(1);
  });

  it('says how to install @bespokecore/vite when the config imports it but the app lacks it — not a module error', () => {
    const root = app();
    rmSync(join(root, 'node_modules/@bespokecore/vite'));
    const { code, out } = build(root);
    expect(out).toContain('vite.config.ts imports @bespokecore/vite, which is not installed in this app: pnpm add -D vite @bespokecore/vite');
    expect(out).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(code).toBe(1);
  });

  it('asks for the bespoke() plugin when vite.config.ts does not use it', () => {
    const { code, out } = build(app({ plugin: false }));
    expect(out).toContain('vite.config.ts does not use the bespoke() plugin');
    expect(out).toContain('plugins: [bespoke(), react()]');
    expect(code).toBe(1);
  });
});
