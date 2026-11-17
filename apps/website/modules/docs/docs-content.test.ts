import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

describe('the content of a page, rendered on the server', () => {
  const document = { headers: { accept: 'text/html' } };
  let ssr: TestApp;
  beforeAll(async () => {
    ssr = await createTestApp(application, { ssr: true, ssrServer: server });
  });
  afterAll(() => ssr?.close());

  it('renders a callout as aside.callout with role="note" and its title', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toMatch(/<aside class="callout [a-z]+" role="note"><p class="callout-title">[A-Za-z]+<\/p>/);
  });

  it('renders a code block with a file name as figure.code > figcaption, and a table inside div.table', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toMatch(/<figure class="code"><figcaption><span class="code-caption">modules\/notes\/routes\.ts<\/span>/);
    expect(html).toMatch(/<div class="table"><table>/);
  });

  it('links the brand to the docs start page and "Framework" to the landing, from the stage top bar', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    const top = html.slice(html.indexOf('<header class="docs-top stage"'), html.indexOf('</header>'));
    expect(top).toMatch(/<a [^>]*href="\/docs"[^>]*aria-label="Marmeon docs home"|<a [^>]*aria-label="Marmeon docs home"[^>]*href="\/docs"/);
    expect(top).toContain('<span class="wordmark-suffix">docs</span>');
    // The top bar's links give way to the magnifier on a phone: the footer is the way back to the landing there.
    expect(html.slice(html.indexOf('<footer class="site-footer site-footer--compact'))).toMatch(/<a [^>]*href="\/"[^>]*>Marmeon home<\/a>/);
    expect(top).toMatch(/<nav aria-label="Site"[^>]*>.*<a [^>]*href="\/"[^>]*>Framework<\/a>/);
  });

  it('has no copy button in the document: it appears once the page runs in a browser', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toContain('class="code-block"');
    expect(html).not.toContain('copy-button');
  });
});
