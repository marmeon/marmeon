import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The stylesheet's layout rules, read as text: the docs tests render on the server and see no layout, and a browser test of the
 * menu would need a browser in CI. A menu that grows with its content instead of scrolling is visible in the rules.
 */
const css = readFileSync(resolve(import.meta.dirname, '../../styles/docs-layout.css'), 'utf8');
const proseCss = readFileSync(resolve(import.meta.dirname, '../../styles/prose.css'), 'utf8');

/** The declarations of `selector`'s rule in `text` (the first one), as property → value. */
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

/** The text of the `@media (max-width: <width>px)` block, the layout below that width. */
function below(text: string, width: number): string {
  const marker = `@media (max-width: ${width}px)`;
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`no layout below ${width}px`);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}' && --depth === 0) return text.slice(text.indexOf('{', start) + 1, index);
  }
  throw new Error(`the layout below ${width}px is not closed`);
}

/** The side navigation gives way to the menu below 1100 px, the table of contents below 1280 px. */
const phone = (text: string) => below(text, 760);
const narrow = (text: string) => below(text, 1099);
const medium = (text: string) => below(text, 1279);

describe('the layout of the docs', () => {
  it('opens the phone menu as a panel that scrolls itself — not as a box as tall as its links', () => {
    const panel = rule(css, '.docs-menu-panel');
    expect(panel.get('overflow-y')).toBe('auto');
    expect(panel.get('max-height')).toMatch(/100dvh/);
  });

  it('shows the side navigation or the phone menu, each once per breakpoint', () => {
    expect(rule(css, '.docs-menu').get('display')).toBe('none');
    expect(rule(narrow(css), '.docs-menu').get('display')).toBe('block');
    expect(rule(narrow(css), '.sidebar').get('display')).toBe('none');
  });

  it('folds the table of contents above the text below 1280 px: the column hides, the folded list shows', () => {
    expect(rule(css, '.toc-mobile').get('display')).toBe('none');
    expect(rule(medium(css), '.toc').get('display')).toBe('none');
    expect(rule(medium(css), '.toc-mobile').get('display')).toBe('block');
  });

  it('gives the phone one column with less room, and no empty pager cell', () => {
    expect(rule(phone(css), '.page.doc-page').get('padding')).toBeDefined();
    expect(rule(phone(css), '.pager > span').get('display')).toBe('none');
  });

  it('keeps the desktop sidebar beside the page and scrolling on its own', () => {
    const sidebar = rule(css, '.sidebar');
    expect(sidebar.get('position')).toBe('sticky');
    expect(sidebar.get('overflow-y')).toBe('auto');
  });
});

describe('the prose', () => {
  it('sets callouts on the dark callout panel, whatever the colour scheme', () => {
    const callout = rule(proseCss, '.doc .callout');
    expect(callout.get('background')).toBe('var(--panel-callout-bg)');
    expect(callout.get('color')).toBe('var(--panel-callout-fg)');
    expect(rule(proseCss, '.doc .callout.caution').get('--callout-fg')).toBe('var(--panel-caution-fg)');
  });

  it('sets the agent block beside the table of contents on the same panel', () => {
    const agent = rule(css, '.toc-agent');
    expect(agent.get('background')).toBe('var(--panel-callout-bg)');
    expect(agent.get('color')).toBe('var(--panel-callout-fg)');
    expect(rule(css, '.toc-agent .toc-agent-title').get('color')).toBe('var(--panel-note-fg)');
  });

  it('keeps a heading’s link to itself reachable: hidden until the heading is hovered or has focus, never removed', () => {
    const anchor = rule(proseCss, '.doc a.anchor');
    expect(anchor.get('opacity')).toBe('0');
    expect(anchor.get('display')).toBeUndefined();
    expect(rule(proseCss, '.doc :is(h2, h3, h4, h5):is(:hover, :focus-within) a.anchor').get('opacity')).toBe('1');
  });
});

const searchCss = readFileSync(resolve(import.meta.dirname, '../../styles/search.css'), 'utf8');

/** The text of the last `@media` block of `query`. */
function media(text: string, query: string): string {
  const start = text.lastIndexOf(`@media (${query})`);
  if (start === -1) throw new Error(`no @media (${query})`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}' && --depth === 0) return text.slice(open + 1, index);
  }
  throw new Error(`@media (${query}) is not closed`);
}

describe('the search as a layer', () => {
  it('fills the screen on a phone', () => {
    const layer = rule(media(searchCss, 'max-width: 760px'), '.search-layer');
    expect(layer.get('height')).toBe('var(--vv-height, 100dvh)');
    expect(layer.get('max-height')).toBe('var(--vv-height, 100dvh)');
    expect(layer.get('inset')).toBe('var(--vv-top, 0) 0 auto 0');
    expect(layer.get('margin')).toBe('0');
  });

  it('scrolls its content itself, below a bounded height', () => {
    expect(rule(searchCss, '.search-layer').get('max-height')).toBe('80dvh');
    const content = rule(searchCss, '.search-layer .marmeon-layer__content');
    expect(content.get('overflow')).toBe('auto');
    expect(content.get('max-height')).toBe('calc(80dvh - 2px)');
  });

  it('animates only for visitors who do not ask for reduced motion', () => {
    const outside = searchCss.replace(media(searchCss, 'prefers-reduced-motion: no-preference'), '');
    expect(outside).not.toMatch(/animation|transition/);
    expect(media(searchCss, 'prefers-reduced-motion: no-preference')).toMatch(/animation:/);
  });
});
