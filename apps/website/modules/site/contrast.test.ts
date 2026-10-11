import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The tokens' contrast, computed from `styles/tokens.css`: every pair of text and ground the pages use meets WCAG's ratio
 * in the light theme and in the dark one. A colour changed to something paler turns this red.
 */
const css = readFileSync(resolve(import.meta.dirname, '../../styles/tokens.css'), 'utf8');

type Theme = Map<string, string>;

/** The custom properties declared in `block`, as name → hex colour. */
function properties(block: string): Theme {
  return new Map([...block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, name, hex]) => [name!, hex!.toLowerCase()]));
}

const dark = css.indexOf('@media (prefers-color-scheme: dark)');
const light = properties(css.slice(0, dark));
const darkOnly = properties(css.slice(dark));
const night: Theme = new Map([...light, ...darkOnly]);

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

/** [text, ground, minimum ratio] */
const PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ...['--fg', '--fg-body', '--fg-2', '--muted'].flatMap((text) => ['--bg', '--bg-raised'].map((ground) => [text, ground, 4.5] as const)),
  ['--accent', '--bg', 4.5],
  ['--accent-strong', '--accent-tint', 4.5],
  ['--term-fg', '--term-bg', 4.5],
  ['--term-dim', '--term-bg', 4.5],
  ['--mark-fg', '--mark-bg', 4.5],
  ['--focus', '--bg', 3],
  ['--focus', '--bg-raised', 3],
  ['--button-fg', '--button-bg', 4.5],
  ['--button-hover-fg', '--button-hover-bg', 4.5],
  ...['note', 'tip', 'important', 'warning', 'caution'].map((kind) => [`--${kind}-fg`, `--${kind}-bg`, 4.5] as const),
  ...['text', 'keyword', 'type', 'string', 'function', 'comment', 'tag', 'punctuation'].map((role) => [`--syn-${role}`, '--bg-raised', 4.5] as const),
  ['--control-line', '--bg', 3],
];

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
      const [front, back] = [theme.get(text), theme.get(ground)];
      if (front === undefined || back === undefined) return [`${text} on ${ground}: not declared`];
      const ratio = contrast(front, back);
      return ratio < minimum ? [`${text} ${front} on ${ground} ${back}: ${ratio.toFixed(2)} < ${minimum}`] : [];
    });
    expect(failures).toEqual([]);
  });

  it('declares the same names in both themes', () => {
    // Names without a dark value (the fonts, the scale) are not colours and are not in `light` either.
    expect([...darkOnly.keys()].sort()).toEqual([...light.keys()].sort());
  });
});
