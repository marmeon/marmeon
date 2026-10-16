import { createTestApp, startSsrServer, type SsrServer } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SSR_TEST_TIMEOUT } from '../docs/test-timeouts.ts';
import { layout } from '../../bootstrap/layouts.ts';
import { DocsLayout } from '../../layouts/DocsLayout.tsx';
import { SiteLayout } from '../../layouts/SiteLayout.tsx';
import { absolute, createPageviewCounter, decide, pageOf } from './components/Pageviews.tsx';
import { fathomScript } from './fathom.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

const document = { headers: { accept: 'text/html' } };
const TAG = '<script src="https://cdn.usefathom.com/script.js" data-auto="false" data-site="IBAFAHEM" defer></script>';
const DEFAULT_POLICY = "script-src 'self'; object-src 'none'; base-uri 'self'; style-src 'self'; frame-ancestors 'none'";

async function visit(env: Record<string, string | undefined>, path: string) {
  // A key of its own: .env.test's is public, and production refuses it.
  const app = await createTestApp(application, { ssr: true, ssrServer: server, env: { APP_KEY: `base64:${crypto.getRandomValues(new Uint8Array(32)).toBase64()}`, ...env } });
  try {
    const response = await app.get(path, document);
    return { body: response.body, policy: response.headers.get('content-security-policy') };
  } finally {
    await app.close();
  }
}

describe('Fathom Analytics', () => {
  it('writes the script into the head of every document in production, and allows its origin for scripts only', async () => {
    for (const path of ['/', '/docs/routing', '/nothing-here']) {
      const { body, policy } = await visit({ NODE_ENV: 'production', SITE_FATHOM_SITE: 'IBAFAHEM' }, path);
      const head = body.slice(0, body.indexOf('</head>'));
      expect(head, path).toContain(TAG);
      expect(body.split('usefathom.com/script.js'), path).toHaveLength(2); // once, and not again on hydration
      expect(policy, path).toBe("script-src 'self' https://cdn.usefathom.com/script.js; object-src 'none'; base-uri 'self'; style-src 'self'; frame-ancestors 'none'");
    }
  }, SSR_TEST_TIMEOUT * 3);

  it('loads nothing in test and development, or without a site', async () => {
    for (const env of [{ SITE_FATHOM_SITE: 'IBAFAHEM' }, { NODE_ENV: 'development', SITE_FATHOM_SITE: 'IBAFAHEM' }, { NODE_ENV: 'production', SITE_FATHOM_SITE: '' }]) {
      const { body, policy } = await visit(env, '/');
      expect(body, JSON.stringify(env)).not.toContain('usefathom');
      if (env.NODE_ENV !== 'development') expect(policy, JSON.stringify(env)).toBe(DEFAULT_POLICY);
    }
  }, SSR_TEST_TIMEOUT * 3);

  it('refuses to boot with a site id that is not one', async () => {
    for (const bad of ['"><script>', 'abcdefgh', 'ABC', 'A'.repeat(17)]) {
      await expect(createTestApp(application, { env: { NODE_ENV: 'production', SITE_FATHOM_SITE: bad } }), bad).rejects.toThrow(/SITE_FATHOM_SITE/);
    }
  });

  it('builds the tag only for a valid id', () => {
    expect(fathomScript('IBAFAHEM')).toBe(TAG);
    expect(() => fathomScript('x" onload="')).toThrow(/uppercase/);
  });

  it('reports the first page and each change of path, without the query', () => {
    const counted: (string | undefined)[][] = [];
    const visit = createPageviewCounter((page, previous) => counted.push([page, previous]));
    visit('/');
    visit('/'); // a partial reload, deferred props, a re-render
    expect(counted).toEqual([['/', undefined]]);
    visit('/docs/routing');
    visit('/docs/routing#middleware'); // a jump to an anchor
    visit('/docs/search?q=a'); // a new page; the terms stay out of what is reported
    visit('/docs/search?q=ab'); // typing in the search: the same page
    visit('/docs/search');
    visit('/docs/routing'); // Back
    expect(counted).toEqual([['/', undefined], ['/docs/routing', '/'], ['/docs/search', '/docs/routing'], ['/docs/routing', '/docs/search']]);
    for (const [page] of counted) expect(page).not.toMatch(/[?#]/);
  });

  it('maps a page to an absolute address on the origin, without query or hash', () => {
    expect(pageOf('/a?b=1#c')).toBe('/a');
    expect(absolute('/docs/search?q=secret#x', 'https://marmeon.com')).toBe('https://marmeon.com/docs/search');
    expect(absolute('/', 'http://localhost:3970')).toBe('http://localhost:3970/');
  });

  it('sends a page only when Fathom is loaded, the address bar shows it and it carries no search', () => {
    const at = (pathname: string, search = '') => ({ pathname, search });
    expect(decide('/docs/routing', at('/docs/routing'), true)).toBe('send');
    expect(decide('/docs/routing#x', at('/docs/routing', '?tab=1'), true)).toBe('send');
    for (const search of ['?q=x', '?%71=x', '?q=', '?a=1&q=x']) expect(decide('/docs/search', at('/docs/search', search), true), search).toBe('skip');
    expect(decide('/docs/routing', at('/docs/search'), true)).toBe('wait');
    expect(decide('/docs/routing', at('/docs/routing'), false)).toBe('wait');
  });

  it('counts pages in both layouts', () => {
    expect(layout('docs/page')).not.toBe(DocsLayout);
    expect(layout('site/landing')).not.toBe(SiteLayout);
    expect((layout('docs/page') as { name: string }).name).toBe('Counted');
    expect((layout('site/landing') as { name: string }).name).toBe('Counted');
  });
});
