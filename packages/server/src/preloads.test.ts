import { describe, expect, it } from 'vitest';
import { assetPreloads, parseManifest, preloadTags, type ViteManifest } from './preloads.ts';

const manifest: ViteManifest = {
  'index.html': { file: 'assets/index-a.js', isEntry: true, imports: ['_vendor'] },
  _vendor: { file: 'assets/vendor-a.js', imports: ['_rolldown-runtime'] },
  '_rolldown-runtime': { file: 'assets/rolldown-runtime-a.js' },
  _CopyButton: { file: 'assets/CopyButton-a.js', imports: ['_vendor'] },
  _descriptions: { file: 'assets/descriptions-a.js' },
  _Terminal: { file: 'assets/Terminal-a.js', imports: ['_vendor', '_CopyButton'] },
  _CodeBlock: { file: 'assets/CodeBlock-a.js', imports: ['_CopyButton'] },
  'modules/site/views/Landing.tsx': {
    file: 'assets/Landing-a.js',
    isDynamicEntry: true,
    imports: ['_vendor', 'index.html', '_CopyButton', '_descriptions', '_Terminal', '_CodeBlock'],
  },
  'modules/site/views/Docs.tsx': { file: 'assets/Docs-a.js', isDynamicEntry: true, imports: ['_vendor', '_CodeBlock'] },
  'node_modules/x/modules/a/views/B.tsx': { file: 'assets/B-a.js', isDynamicEntry: true },
  '../../packages/http/dist/client/features/tab-sync.js': { file: 'assets/tab-sync-a.js', isDynamicEntry: true, imports: ['_vendor'] },
  '../../packages/http/dist/client/features/history-fallback.js': { file: 'assets/history-fallback-a.js', isDynamicEntry: true },
};

const hrefs = (preloads: readonly { href: string }[]) => preloads.map((preload) => preload.href);

describe('assetPreloads', () => {
  it('lists the page chunk, its imports depth first and tab sync — each once, without the entry shell', () => {
    expect(hrefs(assetPreloads(manifest).forPage({ component: 'site/Landing' }))).toEqual([
      '/assets/Landing-a.js',
      '/assets/CopyButton-a.js',
      '/assets/descriptions-a.js',
      '/assets/Terminal-a.js',
      '/assets/CodeBlock-a.js',
      '/assets/tab-sync-a.js',
    ]);
  });

  it('names the entry and its imports as the initial set', () => {
    expect(hrefs(assetPreloads(manifest).initial)).toEqual(['/assets/index-a.js', '/assets/vendor-a.js', '/assets/rolldown-runtime-a.js']);
  });

  it('adds the chunks of a deep-linked layer; an unknown component gets only tab sync', () => {
    const preloads = assetPreloads(manifest);
    const withLayer = hrefs(preloads.forPage({ component: 'site/Docs', layers: [{ component: 'site/Landing', props: {}, url: '/' }] }));
    expect(withLayer).toEqual(expect.arrayContaining(['/assets/Docs-a.js', '/assets/Landing-a.js', '/assets/tab-sync-a.js']));
    expect(withLayer.filter((href) => href === '/assets/CodeBlock-a.js')).toHaveLength(1);
    expect(hrefs(preloads.forPage({ component: 'site/Nope' }))).toEqual(['/assets/tab-sync-a.js']);
  });

  it('preloads no tab sync when the manifest has none, and never history-fallback', () => {
    const rest = { ...manifest };
    delete rest['../../packages/http/dist/client/features/tab-sync.js'];
    expect(hrefs(assetPreloads(rest).forPage({ component: 'site/Docs' }))).toEqual(['/assets/Docs-a.js', '/assets/CodeBlock-a.js', '/assets/CopyButton-a.js']);
    expect(hrefs(assetPreloads(manifest).forPage({ component: 'site/Docs' }))).not.toContain('/assets/history-fallback-a.js');
  });

  it('makes pages only of the app’s own views', () => {
    const preloads = assetPreloads({ ...manifest, 'modules/pkg::x/views/Page.tsx': { file: 'assets/P.js' } });
    expect(hrefs(preloads.forPage({ component: 'a/B' }))).toEqual(['/assets/tab-sync-a.js']);
    expect(hrefs(preloads.forPage({ component: 'pkg::x/Page' }))).toEqual(['/assets/tab-sync-a.js']);
  });

  it('ignores an import that is no chunk (an inherited property)', () => {
    const preloads = assetPreloads({ ...manifest, 'modules/site/views/Odd.tsx': { file: 'assets/Odd-a.js', imports: ['toString'] } });
    expect(hrefs(preloads.forPage({ component: 'site/Odd' }))).toEqual(['/assets/Odd-a.js', '/assets/tab-sync-a.js']);
  });
});

describe('preloadTags', () => {
  it('puts the nonce on modulepreloads only when there is one', () => {
    const preloads = [{ href: '/assets/a.js', as: 'script' as const }];
    expect(preloadTags(preloads, 'N0NCE')).toBe('<link rel="modulepreload" href="/assets/a.js" crossorigin nonce="N0NCE">');
    expect(preloadTags(preloads, undefined)).not.toContain('nonce');
  });

  it('preloads fonts without a nonce', () => {
    expect(preloadTags([{ href: '/assets/f.woff2', as: 'font' }], 'N0NCE')).toBe('<link rel="preload" as="font" href="/assets/f.woff2" crossorigin>');
  });

  it('escapes a file name that tries to leave the attribute', () => {
    const tags = preloadTags([{ href: '/x"><script>alert(1)</script>', as: 'script' }], undefined);
    expect(tags).not.toContain('<script');
    expect(tags).not.toContain('">');
  });
});

describe('parseManifest', () => {
  it('accepts the file names rolldown writes — non-ASCII, spaces — and preloads them as percent-encoded paths', () => {
    const parsed = parseManifest({ 'modules/site/views/Übersicht.tsx': { file: 'assets/Übersicht (1)~b-x.js' } }, 'm.json');
    expect(hrefs(assetPreloads(parsed).forPage({ component: 'site/Übersicht' }))).toEqual(['/assets/%C3%9Cbersicht%20(1)~b-x.js']);
  });

  it('returns a valid manifest', () => {
    expect(parseManifest(manifest, 'm.json')).toBe(manifest);
  });

  it.each([[[]], [{ a: { file: 1 } }], [{ a: { file: 'x', imports: 'y' } }], [{ a: { file: 'x', isEntry: 'false' } }], [{ a: { file: '/x.js' } }], [{ a: { file: '//x/y.js' } }], [{ a: { file: '\t/evil.example/x.js' } }], [{ a: { file: '../x.js' } }], [{ a: { file: '%2e%2e/x.js' } }], [{ a: { file: 'assets\\..\\x.js' } }], [{ a: { file: 'assets/./x.js' } }], [{ a: { file: 'assets/a.js?x' } }], [{ a: { file: 'assets/a.js#x' } }], [{ a: { file: 'a%zz.js' } }], [{ a: { file: '\\x.js' } }], [null]])('rejects %j, naming the file', (json) => {
    expect(() => parseManifest(json, 'dist/client/.vite/manifest.json')).toThrow(/dist\/client\/\.vite\/manifest\.json is not a Vite manifest/);
  });
});
