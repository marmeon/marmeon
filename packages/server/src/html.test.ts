import { describe, expect, it } from 'vitest';
import { documentOf, renderDocument, withLang, withPreloads } from './html.ts';

const template = '<html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>';
const page = { component: 'x/Y', props: { bio: '</script><script>alert(1)</script>' }, url: '/' };

describe('withLang', () => {
  it('sets <html lang> to the page locale — replacing the template’s, keeping its other attributes', () => {
    expect(withLang('<!doctype html>\n<html lang="en" class="x">', 'de')).toBe('<!doctype html>\n<html lang="de" class="x">');
    expect(withLang('<html>', 'de-AT')).toBe('<html lang="de-AT">');
    expect(renderDocument('<html lang="en"><head></head><body><div id="app"><!--app-html--></div></body></html>', { ...page, locale: 'de' }, { html: '' })).toMatch(/^<html lang="de">/);
  });

  it('a locale that is no language tag never reaches the document (the second line behind the allow-list of @marmeon/i18n)', () => {
    for (const locale of ['de"><script>alert(1)</script>', '../../x', 'de en', '']) expect(withLang('<html lang="en">', locale)).toBe('<html lang="en">');
  });
});

describe('renderDocument', () => {
  it('fills the outlets and puts the page script into the head — before the markup, which may still be streaming', () => {
    const html = renderDocument(template, page, { html: '<p>hi</p>', head: '<title>T</title>' });
    expect(html).toMatch(/^<html><head><title>T<\/title><script type="application\/json" id="marmeon-page">.*<\/script>\n<\/head>/);
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
    const html = renderDocument(template, page, { html: '', head: '<title data-marmeon-head="ssr">Ada — Shop</title>' });
    expect(html).toContain('<head><title data-marmeon-head="ssr">Ada — Shop</title><script type="application/json" id="marmeon-page">');
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
    const document = await documentOf(template, page, { html: markup, head: '<title>T</title>' });
    expect(typeof document).not.toBe('string');
    const html = await new Response(document).text();
    expect(html).toMatch(/^<html><head><title>T<\/title><script type="application\/json" id="marmeon-page">.*<\/script>\n<\/head><body><div id="app"><p>shell<\/p><p>later<\/p><\/div><\/body><\/html>$/);

    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(encoder.encode('.')) });
    await ((await documentOf(template, page, { html: endless }, (reason) => (cancelled = reason))) as ReadableStream<Uint8Array>).cancel('gone');
    expect(cancelled).toBe('gone');
  });

  it('has the head and the shell ready together — a server writes both at once, not a tick later', async () => {
    // The rest never comes (an island still loading): only what is ready may be read.
    const streaming = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode('<p>shell</p>')) });
    const reader = ((await documentOf(template, page, { html: streaming })) as ReadableStream<Uint8Array>).getReader();
    // What `@hono/node-server` does before it writes the headers: a read, without waiting longer than a microtask.
    const ready = async () => (await Promise.race([reader.read(), Promise.resolve().then(() => undefined)]))?.value;
    const decoder = new TextDecoder();
    expect(decoder.decode(await ready())).toContain('<head>');
    expect(decoder.decode(await ready())).toBe('<p>shell</p>');
  });

  it('is a string for string markup', async () => {
    expect(await documentOf(template, page, { html: '<p>hi</p>' })).toContain('<div id="app"><p>hi</p></div>');
  });
});

describe('withPreloads', () => {
  it('puts the tags before the head outlet, else before </head>, else leaves the template alone', () => {
    expect(withPreloads('<head><!--app-head--></head>', '<link>')).toBe('<head><link>\n<!--app-head--></head>');
    expect(withPreloads('<head><title>x</title></head>', '<link>')).toBe('<head><title>x</title><link>\n</head>');
    expect(withPreloads('<div></div>', '<link>')).toBe('<div></div>');
  });

  it('does not expand $& in the tags', () => {
    expect(withPreloads('<head></head>', '<link href="$&">')).toContain('<link href="$&">');
  });
});
