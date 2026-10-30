import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { Redactor } from '@marmeon/core';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { marmeonEntries, createViteDevRenderer, explainConfigError, importVite, ViteSetupError } from './vite.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));

/** A UI-free app: `marmeon()` with its own entries, a page, and Vite + @marmeon/vite linked in (or not). */
function app({ vite = true, framework = true, config }: { vite?: boolean; framework?: boolean; config?: string } = {}): string {
  const root = tempDir('marmeon-vite-dev-');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'index.html': '<html><head><!--app-head--></head><body><!--app-html--></body></html>',
    'bootstrap/ssr.ts': [
      "import pages from 'virtual:marmeon/pages';",
      'export const render = async (page: { component: string }) => ({ html: `${page.component}: ${Object.keys(pages).join(",")}` });',
    ].join('\n'),
    'modules/demo/views/Home.tsx': "export default 'home';\n",
    'vite.config.ts':
      config ??
      [
        "import { marmeon } from '@marmeon/vite';",
        "export default { plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' } })] };",
      ].join('\n'),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, 'node_modules/@marmeon'), { recursive: true });
  if (vite) symlinkSync(vitePackage, join(root, 'node_modules/vite'), 'dir');
  if (framework) symlinkSync(join(repo, 'packages/vite'), join(root, 'node_modules/@marmeon/vite'), 'dir');
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
    let body = '<a href="/_marmeon/devtools" data-marmeon-devtools>Devtools</a>';
    const httpServer = createServer();
    const { vite, renderer } = await createViteDevRenderer({ root: app(), httpServer, devBody: () => body });
    try {
      const render = () => renderer.render({ component: 'demo/Home', props: {}, url: '/', version: null }, new Request('http://localhost/'), { complete: false, onError() {}, onWarning() {} });
      expect(await render()).toContain('<a href="/_marmeon/devtools" data-marmeon-devtools>Devtools</a>\n</body>');
      body = '';
      expect(await render()).not.toContain('data-marmeon-devtools');
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('adds development head HTML (DevDocument: the devtools\' bar) before </head> — ahead of the app\'s entry', async () => {
    const httpServer = createServer();
    const { vite, renderer } = await createViteDevRenderer({ root: app(), httpServer, devHead: () => '<script type="module" src="/@id/@marmeon/devtools/client" data-marmeon-devtools></script>' });
    try {
      const html = String(await renderer.render({ component: 'demo/Home', props: {}, url: '/', version: null }, new Request('http://localhost/'), { complete: false, onError() {}, onWarning() {} }));
      const bar = html.indexOf('/@id/@marmeon/devtools/client');
      expect(bar).toBeGreaterThan(-1);
      expect(bar).toBeLessThan(html.indexOf('</head>'));
      expect(bar).toBeLessThan(html.indexOf('/bootstrap/client.ts'));
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('takes the SSR entry from marmeon(), serves virtual:marmeon/pages to SSR, and adds the client entry', async () => {
    const { vite, renderer } = await start(app());
    try {
      const html = await renderer.render({ component: 'demo/Home', props: {}, url: '/', version: null }, new Request('http://localhost/'), { complete: false, onError() {}, onWarning() {} });
      expect(html).toContain('demo/Home: /modules/demo/views/Home.tsx');
      expect(html).toContain('<script type="module" src="/bootstrap/client.ts"></script>');
    } finally {
      await vite.close();
    }
  });

  it('shows a server-rendering error of a view in Vite\'s overlay — at the line of the view that threw', async () => {
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
    writeFileSync(join(root, 'modules/demo/views/Broken.tsx'), view.join('\n'));
    writeFileSync(
      join(root, 'bootstrap/ssr.ts'),
      "import { renderView } from '../modules/demo/views/Broken.tsx';\nexport const render = async () => ({ html: renderView({ title: 'broken' }) });\n",
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
      expect(sent[0]).toMatchObject({ type: 'error', err: { loc: { file: join(realpathSync(root), 'modules/demo/views/Broken.tsx'), line } } });
      expect(sent[0]!.err.frame).toContain(`${line} |   if (shown.title === 'broken') throw new Error('The view failed on purpose');`);
      expect(sent[0]!.err.message).toContain('Fix the view: It throws.');
      // The failed document brings the same error for its own tab (Vite buffers only while no tab is connected).
      expect(markup).toMatch(/^<script type="module">import\('\/@vite\/client'\)/);
      expect(markup).toContain(`"line":${line}`);
    } finally {
      await vite.close();
    }
  });

  it('does not serve storage, databases or build output — but still the client sources and public files', async () => {
    const root = app();
    const files: Record<string, string> = {
      'storage/database.sqlite': 'secret',
      'storage/app/private/a.txt': 'secret',
      'data/app.db': 'secret',
      'dist/client/x.js': 'export {};',
      '.marmeon/cache.json': '{}',
      '.env': 'KEY=secret',
      '.env.production': 'KEY=secret',
      'bootstrap/client.ts': 'export {};',
      'public/robots.txt': 'User-agent: *',
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const httpServer = createServer();
    const { vite } = await createViteDevRenderer({ root, httpServer });
    httpServer.on('request', vite.middlewares);
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    const { port } = httpServer.address() as { port: number };
    const status = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).status;
    try {
      for (const path of ['/storage/database.sqlite', '/storage/app/private/a.txt', '/data/app.db', '/dist/client/x.js', '/.marmeon/cache.json']) {
        expect(await status(path), path).toBe(403);
      }
      // Vite's own deny list stays in force.
      expect(await status('/.env')).toBe(403);
      expect(await status('/.env.production')).toBe(403);
      expect(await status('/bootstrap/client.ts')).toBe(200);
      expect(await status('/robots.txt')).toBe(200);
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('explains a missing Vite, a missing @marmeon/vite, and a config without marmeon()', async () => {
    await expect(start(app({ vite: false }))).rejects.toThrow(
      new ViteSetupError('[marmeon:H5] Vite is not installed in this app. `marmeon dev` and `marmeon build` need it: pnpm add -D vite@^8 @marmeon/vite@<version of your app>'),
    );
    await expect(start(app({ framework: false }))).rejects.toThrow(
      new ViteSetupError('[marmeon:H5] vite.config.ts imports @marmeon/vite, which is not installed in this app: pnpm add -D vite@^8 @marmeon/vite@<version of your app>'),
    );
    await expect(start(app({ config: 'export default {};' }))).rejects.toThrow(/^\[marmeon:H5\] vite\.config\.ts does not use the marmeon\(\) plugin/);
  });
});

describe('development stylesheets', () => {
  const page = { component: 'demo/Home', props: {}, url: '/', version: null };
  const options = { complete: false, onError() {}, onWarning() {} };

  /** The fixture app: static, virtual, foreign, CSS-module, broken and lazy stylesheets behind the client entry. */
  function stylesApp(): string {
    const root = app({
      config: [
        "import { marmeon } from '@marmeon/vite';",
        'export default { plugins: [',
        "  marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' } }),",
        // `\\0` writes a NUL escape into the config's source.
        "  { name: 'test-css', resolveId: (id) => (id === 'virtual:test.css' ? '\\0virtual:test.css' : undefined), load: (id) => (id.split('?')[0] === '\\0virtual:test.css' ? 'p { color: red }' : undefined) },",
        "  { name: 'strict-css', resolveId: (id) => (id === 'virtual:strict.css' ? '\\0virtual:strict.css' : undefined), load: (id) => (id === '\\0virtual:strict.css' ? 'p { color: blue }' : undefined) },",
        // Without a PostCSS setup Vite does not parse CSS, so a syntax error is simulated by a plugin that refuses the file.
        "  { name: 'broken-css', transform: (code, id) => { if (id.split('?')[0].endsWith('broken.css')) throw new Error('Unclosed block'); } },",
        '] };',
      ].join('\n'),
    });
    const files: Record<string, string> = {
      'bootstrap/client.ts': [
        "import './dep.ts';",
        "import '../styles/second.css';",
        "import 'virtual:test.css';",
        "import 'virtual:strict.css';",
        "import 'https://example.com/foreign.css';",
        "import '../styles/card.module.css';",
        "import '../styles/broken.css';",
        "export const later = () => import('./lazy.ts');",
      ].join('\n'),
      'bootstrap/dep.ts': "import '../styles/first.css';\nexport {};\n",
      'bootstrap/lazy.ts': "import '../styles/lazy.css';\nexport {};\n",
      'styles/first.css': 'a { color: red }',
      'styles/second.css': 'b { color: red }',
      'styles/third.css': 'i { color: red }',
      'styles/lazy.css': 'u { color: red }',
      'styles/card.module.css': '.card { color: red }',
      'styles/broken.css': 'a { color: red }',
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  async function startStyled(root: string) {
    const httpServer = createServer();
    const started = await createViteDevRenderer({ root, httpServer, styles: true });
    return { ...started, httpServer, render: async (nonce?: string) => String(await started.renderer.render(page, new Request('http://localhost/'), { ...options, ...(nonce ? { nonce } : {}) })) };
  }

  it('links the static stylesheets of the client entry in import order, before </head>', async () => {
    const root = stylesApp();
    const { vite, httpServer, render } = await startStyled(root);
    try {
      const html = await render();
      const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]*)"/g)].map((match) => match[1]);
      expect(links).toEqual(['/styles/first.css', '/styles/second.css', '/@id/__x00__virtual:test.css']);
      expect(html.lastIndexOf('<link rel="stylesheet"')).toBeLessThan(html.indexOf('</head>'));
      expect(html).toContain(`data-vite-dev-id="${realpathSync(root)}/styles/first.css"`);
      const virtual = /<link rel="stylesheet" href="\/@id\/__x00__virtual:test\.css" data-marmeon-dev-id="([^"]*)"/.exec(html);
      expect(JSON.parse(virtual![1]!.replaceAll('&quot;', '"'))).toBe('\0virtual:test.css');
      expect(html.match(/<script nonce|<script>for/g)).toHaveLength(1);
      expect(html.indexOf('<script>for')).toBeGreaterThan(html.indexOf('virtual:test.css'));
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('leaves out lazy, CSS-module, unservable and foreign stylesheets — and still renders', async () => {
    const { vite, httpServer, render } = await startStyled(stylesApp());
    try {
      const html = await render();
      for (const left of ['lazy.css', 'card.module.css', 'broken.css', 'virtual:strict.css', 'example.com']) expect(html, left).not.toContain(left);
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('puts the response\'s nonce on every link and the script, and leaves no placeholder without one', async () => {
    const { vite, httpServer, render } = await startStyled(stylesApp());
    try {
      const html = await render('n0nce');
      expect(html.match(/<link rel="stylesheet"[^>]*nonce="n0nce">/g)).toHaveLength(3);
      expect(html).toContain('<script nonce="n0nce">for(');
      const plain = await render();
      expect(plain).toContain('<link rel="stylesheet"');
      expect(plain).not.toContain('nonce=');
      expect(plain).not.toContain('__marmeon_csp_nonce__');
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('keeps the linked stylesheets hot-updatable: the ?direct module is a self-accepting css module', async () => {
    const { vite, httpServer, render } = await startStyled(stylesApp());
    try {
      await render();
      const node = await vite.environments.client!.moduleGraph.getModuleByUrl('/styles/second.css?direct');
      expect(node?.type).toBe('css');
      expect(node?.isSelfAccepting).toBe(true);
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('shows a stylesheet the entry imports later on the next reload', async () => {
    const root = stylesApp();
    const { vite, httpServer, render } = await startStyled(root);
    try {
      expect(await render()).not.toContain('/styles/third.css');
      writeFileSync(join(root, 'bootstrap/client.ts'), `${readFileSync(join(root, 'bootstrap/client.ts'), 'utf8')}\nimport '../styles/third.css';\n`);
      vite.environments.client!.moduleGraph.onFileChange(join(realpathSync(root), 'bootstrap/client.ts'));
      const html = await render();
      expect(html.indexOf('/styles/third.css')).toBeGreaterThan(html.indexOf('/@id/__x00__virtual:test.css'));
    } finally {
      await vite.close();
      httpServer.close();
    }
  });

  it('links nothing unless asked to', async () => {
    const { vite, renderer } = await start(stylesApp());
    try {
      expect(String(await renderer.render(page, new Request('http://localhost/'), options))).not.toContain('<link rel="stylesheet"');
    } finally {
      await vite.close();
    }
  });
});

describe('Vite setup helpers', () => {
  it('passes other config errors through unchanged', () => {
    const other = Object.assign(new Error("Cannot find package 'left-pad' imported from vite.config.ts"), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(explainConfigError(other)).toBe(other);
    expect(explainConfigError(undefined)).toBeUndefined();
  });

  it('reads the entries from the plugin api', () => {
    expect(marmeonEntries({ plugins: [{ name: 'marmeon', api: { entries: { client: 'a.ts', ssr: 'b.ts' } } }] } as never)).toEqual({ client: 'a.ts', ssr: 'b.ts' });
    expect(() => marmeonEntries({ plugins: [{ name: 'vite:react' }] } as never)).toThrow(ViteSetupError);
  });

  it('imports the app\'s own Vite', async () => {
    expect(typeof (await importVite(app())).createServer).toBe('function');
  });
});
