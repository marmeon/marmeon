import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The headers' layout rules, read as text: the site tests render on the server and see no layout, and a browser test would need a
 * browser in CI. A header that drops its version badge on a phone and keeps the menu at the right is visible in the rules.
 * Also: every relative `url()` in the stylesheets names a file that exists.
 */
const chrome = readFileSync(resolve(import.meta.dirname, '../../styles/chrome.css'), 'utf8');

/** The text of the `@media` block of `query` (the first one). */
function media(text: string, query: string): string {
  const start = text.indexOf(`@media ${query}`);
  if (start === -1) throw new Error(`no @media ${query}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}' && --depth === 0) return text.slice(open + 1, index);
  }
  throw new Error(`@media ${query} is not closed`);
}

/** The declarations of `selector`'s rule in `text` (the first one, comments left out), as property → value. */
function rule(text: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(text)?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return new Map(
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((declaration) => declaration.split(':').map((part) => part.trim()))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '')
      .map(([property, value]) => [property, value]),
  );
}

describe('the header on a phone', () => {
  it('hides the current-version badge below 480px, and only there', () => {
    expect(rule(media(chrome, '(max-width: 479px)'), '.version-badge').get('display')).toBe('none');
    expect(chrome.replace(media(chrome, '(max-width: 479px)'), '')).not.toContain('.version-badge');
  });

  it('keeps the menu and the search at the right when enlarged text wraps the header', () => {
    expect(rule(chrome, '.site-header-inner').get('flex-wrap')).toBe('wrap');
    expect(rule(chrome, '.site-header-end').get('margin-left')).toBe('auto');
    expect(rule(media(chrome, '(max-width: 760px)'), '.docs-top-inner').get('flex-wrap')).toBe('wrap');
    expect(rule(media(chrome, '(max-width: 760px)'), '.docs-search-link').get('margin-left')).toBe('auto');
  });
});

describe('the landing header', () => {
  it('folds the mega menu and the search into the menu below 900px, and only there', () => {
    const narrow = media(chrome, '(max-width: 899px)');
    expect(rule(narrow, '.site-menu').get('display')).toBe('block');
    expect(narrow).toMatch(/\.site-nav,\s*\.site-search,\s*\.site-github\s*\{[^}]*display:\s*none/);
    expect(rule(chrome, '.site-menu').get('display')).toBe('none');
  });

  it('lays the open mega menu over the page: the header is its positioned ancestor and the panel leaves the flow', () => {
    expect(rule(chrome, '.site-header').get('position')).toBe('relative');
    expect(Number(rule(chrome, '.site-header').get('z-index'))).toBeGreaterThan(0);
    expect(rule(chrome, '.site-panel-body').get('position')).toBe('absolute');
  });
});

describe('the headers at their breakpoints', () => {
  it('keeps the landing header on one row from 900px up, and drops the search label below 1150px', () => {
    expect(rule(media(chrome, '(min-width: 900px)'), '.site-header-inner').get('flex-wrap')).toBe('nowrap');
    expect(rule(media(chrome, '(min-width: 900px) and (max-width: 1149px)'), '.site-search-label').get('display')).toBe('none');
  });

  it('hides the docs top bar\'s search box and links on a phone on purpose: the magnifier and the footer take over', () => {
    expect(media(chrome, '(max-width: 760px)')).toMatch(/\.docs-search-box,\s*\.docs-top-nav\s*\{[^}]*display:\s*none/);
  });
});

describe('the stylesheets', () => {
  it('only point at files that exist: every relative url() in styles/ resolves on disk', () => {
    const root = resolve(import.meta.dirname, '../../styles');
    const sheets = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.css'));
    expect(sheets).toContain('base.css');
    const urls = sheets.flatMap((sheet) =>
      [...readFileSync(resolve(root, sheet), 'utf8').matchAll(/url\(\s*(['"]?)(\.{1,2}\/[^'")]+)\1\s*\)/g)].map(([, , path]) => resolve(root, dirname(sheet), path!)),
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((path) => !existsSync(path))).toEqual([]);
  });

  it('colours the testing and islands cards\' own headings only: no selector of testing.css reaches the editor\'s file names', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../styles/landing/testing.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].flatMap((match) => match[1]!.split(',').map((selector) => selector.trim()));
    const headings = selectors.filter((selector) => /(^|[\s>])h[1-6]\b/.test(selector));
    expect(new Set(headings)).toEqual(new Set(['.landing .duo-card > h2']));
    // A bare descendant selector on the band or the card would colour `.editor .tabs-heading` too.
    expect(selectors.filter((selector) => /\.landing-tail\s+(h\d|a)\b/.test(selector))).toEqual([]);
  });
});
