import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SSR_TEST_TIMEOUT } from './test-timeouts.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

describe('the content of a page, rendered on the server', { timeout: 30_000 }, () => {
  const document = { headers: { accept: 'text/html' } };
  let ssr: TestApp;
  beforeAll(async () => {
    ssr = await createTestApp(application, { ssr: true, ssrServer: server });
  }, 30_000);
  afterAll(() => ssr?.close());

  it('renders a callout as aside.callout with role="note" and its title', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toMatch(/<aside class="callout [a-z]+" role="note"><p class="callout-title">[A-Za-z]+<\/p>/);
  }, SSR_TEST_TIMEOUT);

  it('renders a code block with a file name as figure.code > figcaption, and a table inside div.table', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toMatch(/<figure class="code"><figcaption><span class="code-caption">modules\/notes\/routes\.ts<\/span>/);
    expect(html).toMatch(/<div class="table"><table>/);
  }, SSR_TEST_TIMEOUT);

  it('links home from the top bar and the footer, and to the docs start page from the "docs" suffix', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    const home = /<a [^>]*href="\/"[^>]*aria-label="Marmeon, home"|<a [^>]*aria-label="Marmeon, home"[^>]*href="\/"/;
    const top = html.slice(html.indexOf('<header class="docs-top"'), html.indexOf('</header>'));
    expect(top).toMatch(home);
    expect(top).toMatch(/<a [^>]*href="\/docs"[^>]*><span class="wordmark-suffix">docs<\/span><\/a>/);
    expect(html.slice(html.indexOf('<footer class="site-footer"'))).toMatch(home);
  }, SSR_TEST_TIMEOUT);

  it('has no copy button in the document: it appears once the page runs in a browser', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toContain('class="code-block"');
    expect(html).not.toContain('copy-button');
  }, SSR_TEST_TIMEOUT);
});
