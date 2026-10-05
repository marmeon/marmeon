import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { Redactor } from '@bespokecore/core';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bespokeEntries, createViteDevRenderer, explainConfigError, importVite, ViteSetupError } from './vite.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));

/** A UI-free app: `bespoke()` with its own entries, a page, and Vite + @bespokecore/vite linked in (or not). */
function app({ vite = true, framework = true, config }: { vite?: boolean; framework?: boolean; config?: string } = {}): string {
  const root = tempDir('bespoke-vite-dev-');
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
  it('adds the development HTML (DevDocument: the devtools\' link) before </body> — outside the app\'s root, read per request', async () => {
    let body = '<a href="/_bespoke/devtools" data-bespoke-devtools>Devtools</a>';
    const httpServer = createServer();
    const { vite, renderer } = await createViteDevRenderer({ root: app(), httpServer, devBody: () => body });
    try {
      const render = () => renderer.render({ component: 'demo/Home', props: {}, url: '/', version: null }, new Request('http://localhost/'), { complete: false, onError() {}, onWarning() {} });
      expect(await render()).toContain('<a href="/_bespoke/devtools" data-bespoke-devtools>Devtools</a>\n</body>');
      body = '';
      expect(await render()).not.toContain('data-bespoke-devtools');
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('adds development head HTML (DevDocument: the devtools\' bar, W7 step 9) before </head> — ahead of the app\'s entry', async () => {
    const httpServer = createServer();
    const { vite, renderer } = await createViteDevRenderer({ root: app(), httpServer, devHead: () => '<script type="module" src="/@id/@bespokecore/devtools/client" data-bespoke-devtools></script>' });
    try {
      const html = String(await renderer.render({ component: 'demo/Home', props: {}, url: '/', version: null }, new Request('http://localhost/'), { complete: false, onError() {}, onWarning() {} }));
      const bar = html.indexOf('/@id/@bespokecore/devtools/client');
      expect(bar).toBeGreaterThan(-1);
      expect(bar).toBeLessThan(html.indexOf('</head>'));
      expect(bar).toBeLessThan(html.indexOf('/bootstrap/client.ts'));
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('takes the SSR entry from bespoke(), serves virtual:bespoke/pages to SSR, and adds the client entry', async () => {
    const { vite, renderer } = await start(app());
    try {
      const html = await renderer.render({ component: 'demo/Home', props: {}, url: '/', version: null }, new Request('http://localhost/'), { complete: false, onError() {}, onWarning() {} });
      expect(html).toContain('demo/Home: /modules/demo/views/Home.ts');
      expect(html).toContain('<script type="module" src="/bootstrap/client.ts"></script>');
    } finally {
      await vite.close();
    }
  });

  it('shows a server-rendering error of a view in Vite\'s overlay — at the line of the view that threw (E119)', async () => {
    const root = app();
    // Types before the throw: what Vite runs has fewer lines than the source — only the source mapping finds the line.
    const view = [
      'interface Props {',
      '  title: string;',
      '  subtitle?: string;',
      '}',
      'type Shown = Props & { shown: true };',
      '',
      'export function renderView(props: Props): string {',
      '  const shown = { ...props, shown: true } as Shown;',
      "  if (shown.title === 'broken') throw new Error('The view failed on purpose');",
      '  return shown.title;',
      '}',
    ];
    writeFileSync(join(root, 'modules/demo/views/Broken.ts'), view.join('\n'));
    writeFileSync(
      join(root, 'bootstrap/ssr.ts'),
      "import { renderView } from '../modules/demo/views/Broken.ts';\nexport const render = async () => ({ html: renderView({ title: 'broken' }) });\n",
    );
    const { vite, renderer } = await start(root);
    const sent: { type: string; err: { message: string; loc?: { file: string; line: number; column: number }; frame?: string } }[] = [];
    const hot = vite.environments.client!.hot;
    hot.send = ((payload: (typeof sent)[number]) => void sent.push(payload)) as typeof hot.send;
    try {
      const error = await renderer
        .render({ component: 'demo/Broken', props: {}, url: '/', version: null }, new Request('http://localhost/'), { complete: false, onError() {}, onWarning() {} })
        .then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('The view failed on purpose');

      const markup = await renderer.failed!(error, { component: 'demo/Broken', solutions: [{ title: 'Fix the view', text: 'It throws.' }], redactor: new Redactor() });
      const line = view.findIndex((text) => text.includes('throw new Error')) + 1;
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'error', err: { loc: { file: join(realpathSync(root), 'modules/demo/views/Broken.ts'), line } } });
      expect(sent[0]!.err.frame).toContain(`${line} |   if (shown.title === 'broken') throw new Error('The view failed on purpose');`);
      expect(sent[0]!.err.message).toContain('Fix the view: It throws.');
      // The failed document brings the same error for its own tab (Vite buffers only while no tab is connected).
      expect(markup).toMatch(/^<script type="module">import\('\/@vite\/client'\)/);
      expect(markup).toContain(`"line":${line}`);
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
