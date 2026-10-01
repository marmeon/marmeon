import { describe, expect, it } from 'vitest';
import { documentOf, renderDocument } from './html.ts';

const template = '<html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>';
const page = { component: 'x/Y', props: { bio: '</script><script>alert(1)</script>' }, url: '/' };

describe('renderDocument', () => {
  it('fills the outlets and puts the page script into the head — before the markup, which may still be streaming', () => {
    const html = renderDocument(template, page, { html: '<p>hi</p>', head: '<title>T</title>' });
    expect(html).toMatch(/^<html><head><title>T<\/title><script type="application\/json" id="bespoke-page">.*<\/script>\n<\/head>/);
    expect(html).toContain('<div id="app"><p>hi</p></div>');
  });

  it('cannot be broken out of via props', () => {
    const html = renderDocument(template, page, { html: '' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('inserts rendered HTML literally, even with $-patterns', () => {
    expect(renderDocument(template, page, { html: 'costs $& and $1' })).toContain('costs $& and $1');
  });

  it('rejects templates without an HTML outlet', () => {
    expect(() => renderDocument('<html></html>', page, { html: '' })).toThrow(/app-html/);
  });
});

describe('renderDocument — head', () => {
  const template = '<html><head><title>Default</title>\n<!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>';
  const page = { component: 'x', props: {}, url: '/' };

  it('replaces the default title when the page brings its own', () => {
    const html = renderDocument(template, page, { html: '', head: '<title data-bespoke-head="ssr">Ada — Shop</title>' });
    expect(html).toContain('<head><title data-bespoke-head="ssr">Ada — Shop</title><script type="application/json" id="bespoke-page">');
    expect(html).not.toContain('Default');
  });

  it('keeps the default title otherwise', () => {
    expect(renderDocument(template, page, { html: '', head: '<meta name="x" content="y"/>' })).toContain('<title>Default</title>');
  });
});

describe('documentOf — streamed markup', () => {
  const encoder = new TextEncoder();

  it('sends the document around a stream of markup — and tells when the body is cancelled', async () => {
    let cancelled: unknown;
    const markup = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('<p>shell</p>'));
        controller.enqueue(encoder.encode('<p>later</p>'));
        controller.close();
      },
    });
    const document = documentOf(template, page, { html: markup, head: '<title>T</title>' });
    expect(typeof document).not.toBe('string');
    const html = await new Response(document).text();
    expect(html).toMatch(/^<html><head><title>T<\/title><script type="application\/json" id="bespoke-page">.*<\/script>\n<\/head><body><div id="app"><p>shell<\/p><p>later<\/p><\/div><\/body><\/html>$/);

    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(encoder.encode('.')) });
    await (documentOf(template, page, { html: endless }, (reason) => (cancelled = reason)) as ReadableStream<Uint8Array>).cancel('gone');
    expect(cancelled).toBe('gone');
  });

  it('is a string for string markup', () => {
    expect(documentOf(template, page, { html: '<p>hi</p>' })).toContain('<div id="app"><p>hi</p></div>');
  });
});
