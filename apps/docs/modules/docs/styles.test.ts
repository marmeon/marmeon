import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The stylesheet's phone layout, read as text: the docs tests render on the server and see no layout, and a browser test of the
 * menu would need a browser in CI. A menu that grows with its content instead of scrolling is visible in the rules.
 */
const css = readFileSync(resolve(import.meta.dirname, '../../styles/docs.css'), 'utf8');

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

/** The text of the `@media (max-width: 760px)` block — the phone layout. */
function phone(text: string): string {
  const start = text.indexOf('@media (max-width: 760px)');
  if (start === -1) throw new Error('no phone layout');
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}' && --depth === 0) return text.slice(text.indexOf('{', start) + 1, index);
  }
  throw new Error('the phone layout is not closed');
}

describe('the phone layout of the stylesheet', () => {
  it('opens the navigation as an overlay between the header and the bottom that scrolls — not as a box as tall as its links', () => {
    const desktop = rule(css, '.sidebar');
    const overlay = rule(phone(css), '.sidebar');
    const value = (property: string) => overlay.get(property) ?? desktop.get(property);
    expect(value('position')).toBe('fixed');
    expect(value('inset')).toBe('56px 0 0 0');
    // `align-self: start` of the sticky desktop sidebar would size the fixed box to its content (2 564 px at 375 px wide), so
    // nothing scrolls and the links below the screen cannot be reached.
    expect(['auto', 'normal', 'stretch']).toContain(value('align-self'));
    expect(value('overflow-y')).toBe('auto');
  });
});
