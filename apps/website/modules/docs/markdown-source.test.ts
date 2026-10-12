import { describe, expect, it } from 'vitest';
import { replaceLinks, servedHref, sourceLinks, type LinkStyle } from './markdown-source.ts';

const links = (source: string) => {
  const result = sourceLinks(source);
  if ('problem' in result) throw new Error(result.problem);
  return result.links;
};
const hrefs = (source: string) => links(source).map((link) => link.href);

describe('sourceLinks', () => {
  it('leaves fenced and indented code alone', () => {
    expect(hrefs('Text\n\n```md\n[a](routing.md)\n```\n\n    [b](other.md)\n\n[c](real.md)\n')).toEqual(['real.md']);
  });

  it('leaves inline code alone', () => {
    expect(hrefs('Use `[a](b.md)` and ``[c](`d`.md)`` then [e](f.md).')).toEqual(['f.md']);
  });

  it('reads the destination only, not the title', () => {
    const [link] = links('[a](b.md "Title")');
    expect(link).toMatchObject({ href: 'b.md', kind: 'link' });
  });

  it('reads <…> destinations, parentheses in a destination and a link over two lines', () => {
    expect(hrefs('[a](<b c.md>) [d](x_(y).md) [e\nf](g.md)')).toEqual(['b c.md', 'x_(y).md', 'g.md']);
  });

  it('finds links in lists and quotes, and tells an image from a link', () => {
    const found = links('- [a](one.md)\n\n> [b](two.md)\n\n![alt](pic.png)\n');
    expect(found.map((link) => [link.href, link.kind])).toEqual([['one.md', 'link'], ['two.md', 'link'], ['pic.png', 'image']]);
  });

  it('does not list an autolink or an escaped bracket', () => {
    expect(links('<https://example.com> and \\[a\\](b.md)')).toEqual([]);
  });

  it('keeps the offsets of the destination', () => {
    const source = 'See [a](<b.md#x>) and [c](d.md).';
    for (const link of links(source)) expect(source.slice(link.start, link.end)).toBe(link.href);
  });

  it('refuses what the renderer reads differently (fail closed): a reference link, an image inside a link', () => {
    expect(sourceLinks('[a][r]\n\n[r]: b.md\n')).toHaveProperty('problem');
    expect(sourceLinks('[![a](i.png)](b.md)')).toHaveProperty('problem');
    expect(sourceLinks('\\[a](x.md)\n\n`foo\n\n[b](x.md) `')).toHaveProperty('problem');
    expect(sourceLinks('[a][r]\n\n[r]: b.md\n')).toMatchObject({ problem: expect.stringContaining('write links inline') });
  });
});

describe('sourceLinks in tables', () => {
  it('finds the links of header and body cells, and checks them', () => {
    expect(hrefs('| [h](a.md) | b |\n| - | - |\n| x | [u](../UPGRADING.md) |\n')).toEqual(['a.md', '../UPGRADING.md']);
    expect(sourceLinks('| a | [u][r] |\n| - | - |\n| x | y |\n\n[r]: b.md\n')).toHaveProperty('problem');
    expect(sourceLinks('| [![i](p.png)](a.md) | b |\n| - | - |\n| x | y |\n')).toHaveProperty('problem');
  });
});

describe('replaceLinks', () => {
  it('rewrites a destination in place and leaves a code example byte-equal', () => {
    const source = '[a](x.md#h) and\n\n```md\n[b](x.md)\n```\n';
    expect(replaceLinks(source, links(source), (link) => link.href.replace('x.md', 'y.md'))).toBe('[a](y.md#h) and\n\n```md\n[b](x.md)\n```\n');
    expect(replaceLinks(source, links(source), (link) => link.href)).toBe(source);
  });
});

describe('servedHref', () => {
  const pages = new Map([
    ['docs/routing.md', '/docs/routing'],
    ['docs/releases.md', '/docs/releases'],
    ['UPGRADING.md', '/docs/upgrading'],
    ['SECURITY.md', '/docs/security-policy'],
  ]);
  const href = (value: string, file: string, style: LinkStyle = { kind: 'sibling' }) =>
    servedHref({ start: 0, end: value.length, href: value, kind: 'link' }, { file, self: pages.get(file)!, pageOf: (path) => pages.get(path), style });
  const absolute: LinkStyle = { kind: 'absolute', url: (path) => `https://site.test${path}` };

  it('keeps a link between docs pages as it is, and turns a root file into its page', () => {
    expect(href('releases.md#x', 'docs/routing.md')).toBe('releases.md#x');
    expect(href('../UPGRADING.md', 'docs/routing.md')).toBe('upgrading.md');
    expect(href('../SECURITY.md#a', 'docs/routing.md')).toBe('security-policy.md#a');
    expect(href('docs/releases.md#x', 'UPGRADING.md')).toBe('releases.md#x');
  });

  it('reads the destination as the renderer does: unescaped, and a stray % is no crash', () => {
    expect(href('releases\\_x.md', 'docs/routing.md')).toBe('https://github.com/marmeon/marmeon/blob/main/docs/releases_x.md');
    expect(() => href('x%.md#a', 'docs/routing.md')).not.toThrow();
  });

  it('sends a file that is no page to GitHub', () => {
    expect(href('README.md#principles', 'UPGRADING.md')).toBe('https://github.com/marmeon/marmeon/blob/main/README.md#principles');
  });

  it('keeps an anchor, an external link and an image', () => {
    expect(href('#anchor', 'docs/routing.md')).toBe('#anchor');
    expect(href('https://example.com/a', 'docs/routing.md')).toBe('https://example.com/a');
    expect(servedHref({ start: 0, end: 5, href: 'a.png', kind: 'image' }, { file: 'docs/routing.md', self: '/docs/routing', pageOf: () => undefined, style: absolute })).toBe('a.png');
  });

  it('writes absolute URLs when asked, an anchor of the page included', () => {
    expect(href('releases.md#x', 'docs/routing.md', absolute)).toBe('https://site.test/docs/releases.md#x');
    expect(href('#anchor', 'docs/routing.md', absolute)).toBe('https://site.test/docs/routing.md#anchor');
  });
});
