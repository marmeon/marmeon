import { describe, expect, it } from 'vitest';
import { renderDocument } from './html.ts';

const template = '<html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>';
const page = { component: 'x/Y', props: { bio: '</script><script>alert(1)</script>' }, url: '/' };

describe('renderDocument', () => {
  it('fills the outlets and appends the page script', () => {
    const html = renderDocument(template, page, { html: '<p>hi</p>', head: '<title>T</title>' });
    expect(html).toContain('<head><title>T</title></head>');
    expect(html).toContain('<div id="app"><p>hi</p></div>');
    expect(html).toMatch(/<script type="application\/json" id="bespoke-page">.*<\/script>\n<\/body>/);
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
