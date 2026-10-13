import type { IndexHtmlTransformContext, Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { preloadFonts } from './preload-fonts.ts';

const SANS = '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2';
const MONO_500 = '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2';
const MONO_400 = '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2';

function asset(fileName: string, originalFileNames: string[]) {
  return { type: 'asset', fileName, originalFileNames, names: [], needsCodeReference: false, source: '' };
}

function run(files: string[], bundle: Record<string, unknown>) {
  const hook = (preloadFonts(files) as Plugin).transformIndexHtml as {
    handler: (html: string, ctx: IndexHtmlTransformContext) => unknown;
  };
  return hook.handler('<html></html>', { bundle } as unknown as IndexHtmlTransformContext);
}

describe('preloadFonts', () => {
  const bundle = {
    'assets/sans-AAA.woff2': asset('assets/sans-AAA.woff2', [`/repo/node_modules/.pnpm/x@1/node_modules/${SANS}`]),
    'assets/mono400-BBB.woff2': asset('assets/mono400-BBB.woff2', [`C:\\repo\\node_modules\\${MONO_400.replaceAll('/', '\\')}`]),
    'assets/mono500-EEE.woff2': asset('assets/mono500-EEE.woff2', [`/repo/node_modules/${MONO_500}`]),
    'assets/sans-ext-FFF.woff2': asset('assets/sans-ext-FFF.woff2', [
      '/repo/node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-ext-wght-normal.woff2',
    ]),
    'assets/sans-italic-CCC.woff2': asset('assets/sans-italic-CCC.woff2', [
      '/repo/node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-italic.woff2',
    ]),
    'assets/mono600-DDD.woff2': asset('assets/mono600-DDD.woff2', [
      '/repo/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2',
    ]),
  };

  it('returns one preload link per wanted file with its hashed URL', () => {
    expect(run([SANS, MONO_400, MONO_500], bundle)).toEqual([
      { tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: '/assets/sans-AAA.woff2', crossorigin: true }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: '/assets/mono400-BBB.woff2', crossorigin: true }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: '/assets/mono500-EEE.woff2', crossorigin: true }, injectTo: 'head' },
    ]);
  });

  it('does not pick italic or other weights present in the bundle', () => {
    const hrefs = (run([SANS, MONO_400, MONO_500], bundle) as { attrs: { href: string } }[]).map((tag) => tag.attrs.href);
    expect(hrefs).not.toContain('/assets/sans-ext-FFF.woff2');
    expect(hrefs).not.toContain('/assets/sans-italic-CCC.woff2');
    expect(hrefs).not.toContain('/assets/mono600-DDD.woff2');
  });

  it('throws naming a wanted file the build lacks', () => {
    expect(() => run(['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2'], bundle)).toThrow(
      /ibm-plex-mono-latin-700-normal\.woff2/,
    );
  });
});
