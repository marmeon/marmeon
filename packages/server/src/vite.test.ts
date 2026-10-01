import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bespokeEntries, createViteDevRenderer, explainConfigError, importVite, ViteSetupError } from './vite.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));
const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A UI-free app: `bespoke()` with its own entries, a page, and Vite + @bespokecore/vite linked in (or not). */
function app({ vite = true, framework = true, config }: { vite?: boolean; framework?: boolean; config?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bespoke-vite-dev-'));
  temporary.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'index.html': '<html><head><!--app-head--></head><body><!--app-html--></body></html>',
    'bootstrap/ssr.ts': [
      "import pages from 'virtual:bespoke/pages';",
      'export const render = async (page: { component: string }) => ({ html: `${page.component}: ${Object.keys(pages).join(",")}` });',
    ].join('\n'),
    'modules/demo/views/Home.ts': "export default 'home';\n",
    'vite.config.ts':
      config ??
      [
        "import { bespoke } from '@bespokecore/vite';",
        "export default { plugins: [bespoke({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' }, pages: 'modules/*/views/**/*.ts' })] };",
      ].join('\n'),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, 'node_modules/@bespokecore'), { recursive: true });
  if (vite) symlinkSync(vitePackage, join(root, 'node_modules/vite'), 'dir');
  if (framework) symlinkSync(join(repo, 'packages/vite'), join(root, 'node_modules/@bespokecore/vite'), 'dir');
  return root;
}

async function start(root: string) {
  const httpServer = createServer();
  try {
    return await createViteDevRenderer({ root, httpServer });
  } finally {
    httpServer.close();
  }
}

describe('createViteDevRenderer', () => {
  it('takes the SSR entry from bespoke(), serves virtual:bespoke/pages to SSR, and adds the client entry', async () => {
    const { vite, renderer } = await start(app());
    try {
      const html = await renderer.render({ component: 'demo/Home', props: {}, url: '/', version: null }, new Request('http://localhost/'));
      expect(html).toContain('demo/Home: /modules/demo/views/Home.ts');
      expect(html).toContain('<script type="module" src="/bootstrap/client.ts"></script>');
    } finally {
      await vite.close();
    }
  });

  it('explains a missing Vite, a missing @bespokecore/vite, and a config without bespoke()', async () => {
    await expect(start(app({ vite: false }))).rejects.toThrow(
      new ViteSetupError('Vite is not installed in this app. `bespoke dev` and `bespoke build` need it: pnpm add -D vite @bespokecore/vite'),
    );
    await expect(start(app({ framework: false }))).rejects.toThrow(
      new ViteSetupError('vite.config.ts imports @bespokecore/vite, which is not installed in this app: pnpm add -D vite @bespokecore/vite'),
    );
    await expect(start(app({ config: 'export default {};' }))).rejects.toThrow(/^vite\.config\.ts does not use the bespoke\(\) plugin/);
  });
});

describe('Vite setup helpers', () => {
  it('passes other config errors through unchanged', () => {
    const other = Object.assign(new Error("Cannot find package 'left-pad' imported from vite.config.ts"), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(explainConfigError(other)).toBe(other);
    expect(explainConfigError(undefined)).toBeUndefined();
  });

  it('reads the entries from the plugin api', () => {
    expect(bespokeEntries({ plugins: [{ name: 'bespokecore', api: { entries: { client: 'a.ts', ssr: 'b.ts' } } }] } as never)).toEqual({ client: 'a.ts', ssr: 'b.ts' });
    expect(() => bespokeEntries({ plugins: [{ name: 'vite:react' }] } as never)).toThrow(ViteSetupError);
  });

  it('imports the app\'s own Vite', async () => {
    expect(typeof (await importVite(app())).createServer).toBe('function');
  });
});
