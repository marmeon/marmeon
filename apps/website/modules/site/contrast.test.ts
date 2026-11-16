import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The tokens' contrast, computed from `styles/tokens.css`: every pair of text and ground the pages use meets WCAG's ratio. The
 * fixed palette (the stage, the code panels, the dark callout panel) holds in both colour schemes; the themed names hold in the light
 * theme and in the dark one. A colour changed to something paler turns this red.
 */
const css = readFileSync(resolve(import.meta.dirname, '../../styles/tokens.css'), 'utf8');

type Theme = Map<string, string>;

/** The custom properties declared in `block`, as name → hex colour. */
function properties(block: string): Theme {
  return new Map([...block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, name, hex]) => [name!, hex!.toLowerCase()]));
}

/** The three blocks, found by the comment that opens each. */
const at = (marker: string): number => {
  const index = css.indexOf(marker);
  if (index < 0) throw new Error(`tokens.css has no block opened by ${marker}`);
  return index;
};
const [fixedAt, lightAt, darkAt, restAt] = [at('/* Fixed palette'), at('/* Themed, light'), at('/* Themed, dark'), at('/* Type, space')];
const fixed = properties(css.slice(fixedAt, lightAt));
const lightOnly = properties(css.slice(lightAt, darkAt));
const darkOnly = properties(css.slice(darkAt, restAt));
const light: Theme = new Map([...fixed, ...lightOnly]);
const night: Theme = new Map([...fixed, ...lightOnly, ...darkOnly]);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const SYNTAX_ROLES = ['keyword', 'type', 'string', 'function', 'comment', 'tag', 'punctuation'];
const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'];

/**
 * [text, ground, minimum ratio]: what the stylesheets pair today.
 */
const PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  // Themed: the reading surfaces.
  ...['--fg', '--fg-body', '--fg-2', '--muted', '--accent'].flatMap((text) => ['--bg', '--bg-raised'].map((ground) => [text, ground, 4.5] as const)),
  ['--fg', '--bg-sunken', 4.5],
  ['--fg-body', '--bg-sunken', 4.5],
  ['--accent-strong', '--accent-tint', 4.5],
  ['--mark-fg', '--mark-bg', 4.5],
  ['--focus', '--bg', 3],
  ['--focus', '--bg-raised', 3],
  // The global focus ring (base.css) is Teal in both schemes, on the themed ground.
  ['--teal', '--bg', 3],
  ['--teal', '--bg-raised', 3],
  ['--control-line', '--bg', 3],
  ['--accent-bright', '--bg', 3],
  ['--button-fg', '--button-bg', 4.5],
  // The release-line banner is the one themed callout left: its text on its own tint. The docs' links and the draft mark
  // colour a status on the page ground.
  ['--warning-fg', '--warning-bg', 4.5],
  ...['--accent-strong', '--warning-fg'].map((text) => [text, '--bg', 4.5] as const),
  // Fixed, on the stage.
  ...['--stage-fg', '--stage-soft', '--stage-muted', '--sand', '--thread'].map((text) => [text, '--stage', 4.5] as const),
  ...['--stage-fg', '--stage-soft', '--stage-muted'].map((text) => [text, '--panel-raised', 4.5] as const),
  ['--stage-soft', '--code-bg', 4.5],
  // The dark band's devtools window and cards, the final call's terminal and the secure icon tiles: text on the panel.
  ...['--stage-fg', '--stage-fg-strong', '--stage-soft', '--stage-muted', '--stage-dim', '--thread', '--sand', '--error'].map((text) => [text, '--panel', 4.5] as const),
  ['--stage-dim', '--stage', 4.5],
  ['--stage-fg-strong', '--stage', 4.5],
  ['--thread', '--panel-raised', 4.5],
  ['--sand', '--panel-raised', 4.5],
  ['--error', '--panel-raised', 4.5],
  ['--stage-fg', '--panel-raised', 4.5],
  // The copy button on a code panel (always dark): quiet text, its hover on the panel's edge tone, its copied state in Thread.
  ...['--stage-muted', '--stage-fg', '--thread'].flatMap((text) => ['--panel-raised', '--code-bg'].map((ground) => [text, ground, 4.5] as const)),
  ['--stage-fg', '--panel-edge', 4.5],
  ['--stage-fg-strong', '--panel-raised', 4.5],
  ...['--term-fg', '--term-dim', '--term-dim-text'].map((text) => [text, '--panel', 4.5] as const),
  // The window bars of the final call's terminal, the chain and the hero, and the cards of the secure, testing and audience
  // sections.
  ['--term-dim', '--panel-bar', 4.5],
  ['--stage-muted', '--panel-bar', 4.5],
  ...['--ink', '--muted-ink', '--teal'].map((text) => [text, '--card', 4.5] as const),
  ['--thread', '--stage', 3],
  // The compiler's answer on the landing: the failing line's box and the hero's error chip.
  ['--error-fg', '--error-bg', 4.5],
  ['--error-fg', '--error-bg-raised', 4.5],
  ['--error', '--error-bg', 4.5],
  ['--stage-fg', '--error-bg', 4.5],
  ['--ink', '--sand', 4.5],
  // Button hovers: `.button--sand:hover` and `.button--ghost:hover` on their grounds, `.button:hover` on Teal strong.
  ['--stage', '--sand-hover', 4.5],
  ['--paper', '--stage', 4.5],
  ['--paper', '--teal', 4.5],
  ['--paper', '--teal-strong', 4.5],
  // Fixed, code panels and the dark callout panel (the docs' callouts and the agent's call beside the table of contents).
  ...[...SYNTAX_ROLES.map((role) => `--syn-${role}`), '--code-fg'].map((text) => [text, '--code-bg', 4.5] as const),
  ...[...CALLOUT_KINDS.map((kind) => `--panel-${kind}-fg`), '--panel-callout-fg', '--stage-fg-2', '--thread'].map((text) => [text, '--panel-callout-bg', 4.5] as const),
  // The callout's inline code and the agent's call sit on the raised panel.
  ...['--stage-fg-strong', '--thread'].map((text) => [text, '--panel-raised', 4.5] as const),
  // Fixed, the landing's light sections.
  ...['--ink', '--ink-soft', '--teal', '--muted-ink'].flatMap((text) => ['--stone', '--paper', '--card'].map((ground) => [text, ground, 4.5] as const)),
  // The terminal and the editor.
  ['--term-fg', '--term-bg', 4.5],
  ['--term-dim', '--term-bg', 4.5],
  ['--term-dim-text', '--term-bg', 4.5],
  ...['--editor-fg', '--editor-dim', ...SYNTAX_ROLES.map((role) => `--editor-syn-${role}`)].map((text) => [text, '--editor-bg', 4.5] as const),
  ['--editor-dim', '--editor-chrome', 4.5],
  ['--editor-accent', '--editor-chrome', 3],
  ['--editor-accent', '--editor-bg', 3],
];

const stylesDir = resolve(import.meta.dirname, '../../styles');
const stylesheets = (): string[] => (readdirSync(stylesDir, { recursive: true }) as string[]).filter((file) => file.endsWith('.css'));

describe('contrast', () => {
  it('measures contrast the WCAG way', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // A colour made too pale fails the text threshold.
    expect(contrast('#b9bbb5', '#f6f6f3')).toBeLessThan(4.5);
  });

  it.each([
    ['light', light],
    ['dark', night],
  ] as const)('meets the ratio for every text and ground in the %s theme', (_name, theme) => {
    const failures = PAIRS.flatMap(([text, ground, minimum]) => {
      const [front, back] = [text.startsWith('#') ? text : theme.get(text), theme.get(ground)];
      if (front === undefined || back === undefined) return [`${text} on ${ground}: not declared`];
      const ratio = contrast(front, back);
      return ratio < minimum ? [`${text} ${front} on ${ground} ${back}: ${ratio.toFixed(2)} < ${minimum}`] : [];
    });
    expect(failures).toEqual([]);
  });

  it('declares the same names in both themes', () => {
    // The fixed palette has one value; only the themed names change with the scheme. Fonts and the scale are not colours.
    expect([...darkOnly.keys()].sort()).toEqual([...lightOnly.keys()].sort());
  });

  /** The lines of `source` that hold a hex colour (also URL-encoded as `%23…` in a data URI); comments (kept as blank lines, so the numbers stay right) and `url(#id)` fragments do not count. */
  const hexLines = (source: string): number[] =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
      .replace(/url\(\s*['"]?#[^)]*\)/gi, 'url()')
      .split('\n')
      .flatMap((line, index) => (/(#|%23)[0-9a-f]{3,8}\b/i.test(line) ? [index + 1] : []));

  it('finds a hex colour wherever a stylesheet could hide one, and not in a comment or a url fragment', () => {
    const sample = ['a { color: var(--x, #fff); }', 'b { background: color-mix(in srgb, red, #fff); }', 'c { background: linear-gradient(#fff, #000); }', 'd { color: #abc; }', 'e { fill: url(#id); }', 'g { background: url("data:image/svg+xml,%3Csvg fill=%27%23fff%27/%3E"); }', '/* #fff', '#000 */', 'f { color: red; }'].join('\n');
    expect(hexLines(sample)).toEqual([1, 2, 3, 4, 6]);
  });

  it('keeps every hex colour in tokens.css: no other .css file declares one', () => {
    const offenders = stylesheets()
      .filter((file) => file !== 'tokens.css')
      .flatMap((file) => hexLines(readFileSync(resolve(stylesDir, file), 'utf8')).map((line) => `${file}:${line}`));
    expect(stylesheets().length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it('declares no custom property that nothing reads: every name in tokens.css is used by a var() in the styles or the modules', () => {
    const modulesDir = resolve(import.meta.dirname, '..');
    const sources = [
      ...stylesheets().map((file) => readFileSync(resolve(stylesDir, file), 'utf8')),
      ...(readdirSync(modulesDir, { recursive: true }) as string[])
        .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file))
        .map((file) => readFileSync(resolve(modulesDir, file), 'utf8')),
    ].join('\n');
    const declared = [...new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((match) => match[1]!))];
    expect(declared.length).toBeGreaterThan(100);
    expect(declared.filter((name) => !new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(sources))).toEqual([]);
  });

  it('keeps the blocks apart: in order, and no name in both the fixed palette and a themed block', () => {
    expect(fixedAt).toBeLessThan(lightAt);
    expect(lightAt).toBeLessThan(darkAt);
    expect(darkAt).toBeLessThan(restAt);
    expect([...fixed.keys()].filter((name) => lightOnly.has(name) || darkOnly.has(name))).toEqual([]);
  });
});
