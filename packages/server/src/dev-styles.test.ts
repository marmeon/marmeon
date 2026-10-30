import { describe, expect, it } from 'vitest';
import { devStyleTags, isStylesheet, requestUrl } from './dev-styles.ts';

describe('devStyleTags', () => {
  it('writes nothing for no stylesheet', () => {
    expect(devStyleTags([])).toBe('');
  });

  it('escapes the href and the id', () => {
    const tags = devStyleTags([{ href: '/a"><b>&.css', id: '/x/a"><b>&.css' }]);
    expect(tags).toContain('href="/a&quot;&gt;&lt;b&gt;&amp;.css"');
    expect(tags).toContain('data-vite-dev-id="/x/a&quot;&gt;&lt;b&gt;&amp;.css"');
    expect(tags).not.toContain('<b>');
    expect(tags).not.toContain('<script');
    expect(tags).toContain('nonce="__marmeon_csp_nonce__"');
  });

  it('carries an id with NUL as JSON and restores it with one script', () => {
    const id = '\0virtual:marmeon/fonts.css';
    const tags = devStyleTags([
      { href: '/@id/__x00__virtual:marmeon/fonts.css', id },
      { href: '/@id/__x00__virtual:b.css', id: '\0virtual:b.css' },
      { href: '/a.css', id: '/root/a.css' },
    ]);
    const value = /data-marmeon-dev-id="([^"]*)"/.exec(tags)![1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    expect(JSON.parse(value)).toBe(id);
    expect(tags).not.toContain('\0');
    expect(tags.match(/<script/g)).toHaveLength(1);
    expect(tags).toContain('data-vite-dev-id="/root/a.css"');
    expect(tags.indexOf('<script')).toBeGreaterThan(tags.lastIndexOf('<link'));
  });
});

describe('requestUrl', () => {
  it('drops t= and import, keeps direct and other params', () => {
    expect(requestUrl('/a.css?t=123', '/')).toEqual({ href: '/a.css', url: '/a.css' });
    expect(requestUrl('/a.css?import&t=1&direct&x=1', '/')).toEqual({ href: '/a.css?direct&x=1', url: '/a.css?direct&x=1' });
  });

  it('unwraps /@id/ and __x00__ for the request, not for the href', () => {
    expect(requestUrl('/@id/__x00__virtual:a.css', '/')).toEqual({ href: '/@id/__x00__virtual:a.css', url: '\0virtual:a.css' });
  });

  it('strips a base for the request and keeps it in the href', () => {
    expect(requestUrl('/app/styles/a.css', '/app/')).toEqual({ href: '/app/styles/a.css', url: '/styles/a.css' });
    expect(requestUrl('/other/a.css', '/app/')).toBeUndefined();
  });

  it('refuses another origin and Vite\'s client', () => {
    expect(requestUrl('https://example.com/x.css', '/')).toBeUndefined();
    expect(requestUrl('//example.com/x.css', '/')).toBeUndefined();
    expect(requestUrl('/\\example.com/x.css', '/')).toBeUndefined();
    expect(requestUrl('/@vite/client', '/')).toBeUndefined();
  });
});

describe('isStylesheet', () => {
  it('accepts stylesheets, also with a query', () => {
    for (const url of ['/a.css', '/a.scss', '/a.css?direct', '\0virtual:a.css']) expect(isStylesheet(url), url).toBe(true);
  });

  it('refuses what is not a style', () => {
    for (const url of ['/a.css?inline', '/a.css?url', '/a.css?raw', '/a.css?worker', '/a.module.css', '/a.ts', '/a.css.ts']) expect(isStylesheet(url), url).toBe(false);
  });
});
