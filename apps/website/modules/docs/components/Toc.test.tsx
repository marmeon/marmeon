import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Toc } from './Toc.tsx';

describe('the table of contents column', () => {
  it('names itself "For your agent" on a newest page without headings: no title, no label pointing at a missing id', () => {
    const html = renderToStaticMarkup(<Toc entries={[]} slug="routing" />);
    expect(html).toContain('<aside class="toc" aria-label="For your agent">');
    expect(html).not.toContain('toc-title');
    expect(html).not.toContain('aria-labelledby');
    expect(html).toContain('docs_read');
  });

  it('renders nothing for a page without headings and without a slug (a release line)', () => {
    expect(renderToStaticMarkup(<Toc entries={[]} />)).toBe('');
  });

  it('is labelled by its title when there are entries', () => {
    const html = renderToStaticMarkup(<Toc entries={[{ id: 'a', text: 'A', depth: 2 }]} slug="routing" />);
    expect(html).toContain('aria-labelledby="toc-title"');
    expect(html).toContain('id="toc-title"');
    expect(html).not.toContain('aria-label=');
  });
});
