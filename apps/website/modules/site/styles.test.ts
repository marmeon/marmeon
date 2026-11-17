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

  it('keeps the menu and the search at the right of a header that never wraps', () => {
    expect(rule(chrome, '.site-header-inner').get('flex-wrap')).toBe('nowrap');
    expect(rule(chrome, '.site-header-end').get('margin-left')).toBe('auto');
    expect(rule(media(chrome, '(max-width: 760px)'), '.docs-top-inner').get('flex-wrap')).toBe('wrap');
    expect(rule(media(chrome, '(max-width: 760px)'), '.docs-search-link').get('margin-left')).toBe('auto');
  });
});

describe('the landing header', () => {
  it('folds the mega menu into the menu below 900px and swaps the labelled search for a magnifier, and only there', () => {
    const narrow = media(chrome, '(max-width: 899px)');
    expect(rule(narrow, '.site-menu').get('display')).toBe('block');
    expect(narrow).toMatch(/\.site-nav,\s*\.site-search,\s*\.site-github,\s*\.site-start\s*\{[^}]*display:\s*none/);
    expect(rule(chrome, '.site-menu').get('display')).toBe('none');
    // The labelled link is gone and the menu is closed: the magnifier is the visible trigger the shortcut clicks.
    expect(rule(narrow, '.site-search-icon').get('display')).toBe('inline-flex');
    expect(rule(chrome, '.site-search-icon').get('display')).toBe('none');
  });

  it('keeps the header in one row below 900px and opens the menu as a sheet that locks the page scroll, and only there', () => {
    const narrow = media(chrome, '(max-width: 899px)');
    const sheet = rule(narrow, '.site-menu[open] .site-menu-panel');
    expect(sheet.get('position')).toBe('fixed');
    expect(sheet.get('inset')).toBe('var(--site-header-height) 0 0');
    expect(sheet.get('overflow-y')).toBe('auto');
    expect(sheet.get('overscroll-behavior')).toBe('contain');
    expect(rule(narrow, 'html:has(.site-menu[open])').get('overflow')).toBe('hidden');
    expect(chrome.replace(narrow, '')).not.toContain('html:has(.site-menu[open])');
  });

  it('shows an open group alone, as the back row: its siblings are hidden and the chevron gives way to the arrow', () => {
    expect(rule(chrome, '.site-menu-panel:has(> .site-menu-group[open]) > :not([open])').get('display')).toBe('none');
    expect(rule(chrome, '.site-menu-group[open] > summary .site-menu-back').get('display')).toBe('block');
    expect(rule(chrome, '.site-menu-back').get('display')).toBe('none');
    expect(rule(chrome, '.site-menu-group[open] > summary .site-menu-chevron').get('display')).toBe('none');
  });

  it('keeps the header above the page while the sheet is open, so the sheet starts at its bottom edge', () => {
    const sticky = rule(media(chrome, '(max-width: 899px)'), '.site-header:has(.site-menu[open])');
    expect(sticky.get('position')).toBe('sticky');
    expect(sticky.get('top')).toBe('0');
    expect(Number(rule(chrome, '.site-header').get('z-index'))).toBeGreaterThan(0);
  });

  it('puts the sheet at the header\'s height: its token is the row\'s min-height plus the border', () => {
    const height = rule(chrome, '.site-header').get('--site-header-height');
    const row = Number.parseInt(rule(chrome, '.site-header-inner').get('min-height') ?? '', 10);
    const border = Number.parseInt(/^(\d+)px solid/.exec(rule(chrome, '.site-header').get('border-bottom') ?? '')?.[1] ?? '', 10);
    expect(height).toBe(`${row + border}px`);
  });

  it('lays the open mega menu over the page: the header is its positioned ancestor and the panel leaves the flow', () => {
    expect(rule(chrome, '.site-header').get('position')).toBe('relative');
    expect(Number(rule(chrome, '.site-header').get('z-index'))).toBeGreaterThan(0);
    expect(rule(chrome, '.site-panel-body').get('position')).toBe('absolute');
  });
});

describe('the headers at their breakpoints', () => {
  it('keeps the landing header on one row at every width, and drops the search label below 1150px', () => {
    expect(rule(chrome, '.site-header-inner').get('flex-wrap')).toBe('nowrap');
    expect(media(chrome, '(min-width: 900px)')).not.toContain('flex-wrap');
    expect(media(chrome, '(max-width: 899px)')).not.toContain('flex-wrap');
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
