import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The stylesheet's layout rules, read as text: the docs tests render on the server and see no layout, and a browser test of the
 * menu would need a browser in CI. A menu that grows with its content instead of scrolling is visible in the rules.
 */
const css = readFileSync(resolve(import.meta.dirname, '../../styles/docs-layout.css'), 'utf8');

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

describe('the layout of the docs', () => {
  it('opens the phone menu as a panel that scrolls itself — not as a box as tall as its links', () => {
    const panel = rule(css, '.docs-menu-panel');
    expect(panel.get('overflow-y')).toBe('auto');
    expect(panel.get('max-height')).toMatch(/100dvh/);
  });

  it('shows the side navigation or the phone menu, each once per breakpoint', () => {
    expect(rule(css, '.docs-menu').get('display')).toBe('none');
    expect(rule(phone(css), '.docs-menu').get('display')).toBe('block');
    expect(rule(phone(css), '.sidebar').get('display')).toBe('none');
  });

  it('keeps the desktop sidebar beside the page and scrolling on its own', () => {
    const sidebar = rule(css, '.sidebar');
    expect(sidebar.get('position')).toBe('sticky');
    expect(sidebar.get('overflow-y')).toBe('auto');
  });
});
