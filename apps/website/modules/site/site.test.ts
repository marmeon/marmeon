import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SSR_TEST_TIMEOUT } from '../docs/test-timeouts.ts';
import { SNIPPETS } from './snippets.ts';

const repo = resolve(import.meta.dirname, '../../../..');
const document = { headers: { accept: 'text/html' } };
const coreVersion = (JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')) as { version: string }).version;

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application, { ssr: true });
}, 60_000);
afterAll(() => app?.close());

describe('the landing page', () => {
  it('answers / rendered on the server, with one h1 and the three ways in', async () => {
    const response = await app.get('/', document).assertOk().assertServerRendered().assertHydrates();
    expect(response.body.match(/<h1[ >]/g)).toHaveLength(1);
    expect(response.body).toContain('One type, from the database column to the form error.');
    expect(response.body).toMatch(/<a [^>]*class="button"[^>]*href="\/docs\/installation"|<a [^>]*href="\/docs\/installation"[^>]*class="button"/);
    expect(response.body).toMatch(/<a [^>]*href="\/docs"[^>]*class="button button--secondary"|<a [^>]*class="button button--secondary"[^>]*href="\/docs"/);
    expect(response.body).toMatch(/<a [^>]*class="button button--text"[^>]*href="https:\/\/github\.com\/marmeon\/marmeon"/);
    expect(response.body).toContain('pnpm create marmeon my-app');
  }, SSR_TEST_TIMEOUT);

  it('lists the seven principles and the seven steps of the chain', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body.match(/<li class="principle"/g)).toHaveLength(7);
    expect(body.match(/<li class="chain-step"/g)).toHaveLength(7);
    expect(body.match(/<h3>/g)).toHaveLength(7);
    for (const mistake of ['user_ud', 'ctx.params.nte', 'notes.indx', 'note.titel', 'form.errors.titel']) expect(body).toContain(mistake);
  }, SSR_TEST_TIMEOUT);

  it('highlights every snippet on the server, with classes and without a style attribute', async () => {
    const props = (await app.navigating().get('/').assertOk().assertPage('site/Landing')).page()!.props as { snippets: Record<string, { file?: string; html: string }> };
    const snippets = Object.entries(props.snippets);
    expect(snippets.map(([name]) => name)).toEqual(Object.keys(SNIPPETS));
    for (const [name, { html }] of snippets) {
      expect(html, name).toContain('<pre class="code"');
      expect(html, name).toMatch(/class="t[kyfsgcp]"/);
      expect(html, name).not.toContain('style=');
    }
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('<span class="tk">export</span>');
    expect(body).not.toMatch(/<[a-z][^>]*\sstyle=/i);
  }, SSR_TEST_TIMEOUT);

  it('is public: cacheable with an ETag, no cookie, a policy without a nonce', async () => {
    const response = await app.get('/', document).assertOk();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('etag')).toMatch(/^"[\w-]{27}"$/);
    expect(response.headers.get('content-security-policy')).toBe("script-src 'self'; object-src 'none'; base-uri 'self'; style-src 'self'; frame-ancestors 'none'");
    expect(response.body).not.toMatch(/<[a-z]+ [^>]*\bnonce=/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const json = await app.navigating().get('/').assertOk();
    expect(json.headers.get('etag')).not.toBe(response.headers.get('etag'));
    for (const answer of [response, json]) {
      const vary = answer.headers.get('vary')!.toLowerCase().split(/\s*,\s*/);
      expect(vary).toEqual(expect.arrayContaining(['x-marmeon', 'x-marmeon-partial-component', 'x-marmeon-partial-data', 'x-marmeon-partial-except', 'purpose', 'x-marmeon-once', 'x-marmeon-version']));
    }
  });

  it('shares the framework version but not the docs navigation (the navigation belongs to the docs routes)', async () => {
    const props = (await app.navigating().get('/').assertOk().assertPage('site/Landing')).page()!.props;
    expect(props.site).toEqual({ version: coreVersion });
    expect(props).not.toHaveProperty('nav');
    const docs = (await app.navigating().get('/docs/routing').assertOk()).page()!.props;
    expect(docs).toHaveProperty('nav');
    expect(docs.site).toEqual({ version: coreVersion });
  });

  it('answers a revalidation with 304', async () => {
    const etag = (await app.get('/', document).assertOk()).headers.get('etag')!;
    const again = await app.get('/', { headers: { accept: 'text/html', 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });
});

describe('the shared chrome', () => {
  it('renders the header with the docs and GitHub links, the version badge and the footer', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('<a class="skip-link" href="#content">');
    expect(body).toMatch(/<nav aria-label="Main"[^>]*>.*href="\/docs".*<\/nav>/);
    expect(body).toMatch(/<a href="https:\/\/github\.com\/marmeon\/marmeon" rel="noopener">GitHub<\/a>/);
    expect(body).toContain(`<span class="badge">${coreVersion}</span>`);
    expect(body).toContain('<details class="site-menu"');
    const footer = body.slice(body.indexOf('<footer'));
    for (const href of ['/docs', '/docs/security-policy', '/docs/releases', 'https://github.com/marmeon/marmeon/blob/main/LICENSE']) expect(footer).toContain(`href="${href}"`);
    expect(footer).toContain('MIT licence');
  }, SSR_TEST_TIMEOUT);

  it('renders no copy button on the server: it appears with JavaScript only', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).not.toContain('copy-button');
    expect(body).not.toContain('aria-live');
  }, SSR_TEST_TIMEOUT);

  it('gives an unknown path the header and footer but no version badge', async () => {
    const response = await app.get('/nothing-here', document);
    expect(response.status).toBe(404);
    expect(response.body).toContain('class="site-header"');
    expect(response.body).toContain('class="site-footer"');
    expect(response.body).not.toContain('class="badge"');
  }, SSR_TEST_TIMEOUT);

  it('keeps the docs layout for the docs pages', async () => {
    const body = (await app.get('/docs/routing', document).assertOk()).body;
    expect(body).toContain('class="shell"');
    expect(body).not.toContain('class="site-header"');
  }, SSR_TEST_TIMEOUT);
});
