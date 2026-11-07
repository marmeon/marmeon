import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The header's layout rules, read as text: the site tests render on the server and see no layout, and a browser test would need a
 * browser in CI. A header that drops its version badge on a phone and keeps the menu at the right is visible in the rules.
 */
const chrome = readFileSync(resolve(import.meta.dirname, '../../styles/chrome.css'), 'utf8');
const docs = readFileSync(resolve(import.meta.dirname, '../../styles/docs-layout.css'), 'utf8');

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
    expect(rule(media(docs, '(max-width: 760px)'), '.docs-top').get('flex-wrap')).toBe('wrap');
    expect(rule(media(docs, '(max-width: 760px)'), '.docs-top-end').get('margin-left')).toBe('auto');
  });
});
