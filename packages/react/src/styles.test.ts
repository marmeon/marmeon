import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The text between the braces of the single top-level block, and what stands outside it. */
function topLevel(source: string): { order: string; prelude: string; inside: string; outside: string } {
  const statement = /^\s*(@layer[^{;]*;)/.exec(source);
  const order = statement?.[1] ?? '';
  source = source.slice(statement ? statement[0].length : 0);
  const open = source.indexOf('{');
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) {
      close = i;
      break;
    }
  }
  return {
    order,
    prelude: source.slice(0, open).trim(),
    inside: source.slice(open + 1, close),
    outside: source.slice(close + 1).trim(),
  };
}

describe('styles.css', () => {
  const block = topLevel(css);

  it('is one @layer marmeon block with no rule outside it', () => {
    // An unlayered rule would beat every layered rule of the app, utilities included.
    expect(block.prelude).toBe('@layer marmeon');
    expect(block.outside).toBe('');
    expect(css.match(/@layer/g)).toHaveLength(2);
  });

  it('opens with the one order statement, base before marmeon', () => {
    expect(block.order).toBe('@layer base, marmeon;');
    expect(css.trimStart().startsWith(block.order)).toBe(true);
  });

  it('gives the confirm dialog a margin, a backdrop and buttons of its own', () => {
    // A CSS reset removes the browser's own `margin: auto`, backdrop and button look.
    expect(block.inside).toMatch(/:where\(\.marmeon-confirm:modal[^)]*\)\s*\{\s*margin:\s*auto;/);
    expect(block.inside).toMatch(/\.marmeon-confirm[^{]*::backdrop\s*\{[^}]*background:/);
    expect(block.inside).toMatch(/\.marmeon-confirm__actions button\)\s*\{[^}]*border:\s*1px solid[^}]*cursor:\s*pointer/);
  });

  it('centres the dialog of a failed visit as well', () => {
    expect(block.inside).toMatch(/\.marmeon-failure--server:modal[^{]*\{\s*margin:\s*auto;/);
  });

  it('keeps the slideover at the right edge', () => {
    expect(block.inside).toMatch(/:where\(\.marmeon-layer--slideover\)\s*\{\s*margin:\s*0 0 0 auto;/);
    expect(block.inside).not.toMatch(/\.marmeon-layer--slideover:modal/);
  });
});
