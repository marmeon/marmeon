import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as components from '../packages/react/src/mail.ts';
import { UNIT_PROPS } from '../packages/react/src/mail/checks.ts';

// What the components of `@marmeon/react/mail` keep from MJML and from the library they are built on: the other half of the
// compatibility test of `packages/react/src/mail/implementation.type-test.ts`. Replacing the library changes this file's
// reading of its manifest and nothing in the expectations about MJML.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, any>;
const fromReact = createRequire(join(root, 'packages/react/package.json'));
const fromMail = createRequire(join(root, 'packages/mail/package.json'));

const LIBRARY = '@faire/mjml-react';
const pinned = read('packages/react/package.json').dependencies[LIBRARY] as string;
const library = JSON.parse(readFileSync(fromReact.resolve(`${LIBRARY}/package.json`), 'utf8')) as Record<string, any>;
const installed = (JSON.parse(readFileSync(fromMail.resolve('mjml/package.json'), 'utf8')) as { version: string }).version;

/** Tags MJML has that no component wraps, each with the reason. */
const NOT_WRAPPED: Readonly<Record<string, string>> = {
  'mj-include': 'it reads a file of the server (mjml turns it off, and a view has no use for it)',
};

/** What MJML knows and the components do not take yet, per tag — each one a decided difference (`feature` closes it, and the line goes). */
const KNOWN_GAPS: Readonly<Record<string, readonly string[]>> = {
  mjml: ['dir'],
  'mj-section': ['gutter'],
  'mj-wrapper': ['gutter'],
  'mj-social': ['border'],
  'mj-social-element': ['border'],
};

/** Attributes every component takes beyond the ones MJML lists: its two ways to name a class. */
const OWN = new Set(['cssClass', 'mjmlClass']);

const camel = (attribute: string) => attribute.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const tagOf = (name: string) => (name === 'MjmlDocument' ? 'mjml' : `mj${name.slice(4).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);

/** The component functions of the entry point, by tag. */
const wrapped = new Map(Object.keys(components).filter((name) => name.startsWith('Mjml')).map((name) => [tagOf(name), name]));

/** The props each component declares, read from the text of `props.ts`; a component with an index signature takes any attribute. */
function declaredProps(): Map<string, { keys: Set<string>; any: boolean }> {
  const text = readFileSync(join(root, 'packages/react/src/mail/props.ts'), 'utf8');
  const found = new Map<string, { keys: Set<string>; any: boolean }>();
  for (const match of text.matchAll(/export interface (Mjml\w*)Props \{\n([\s\S]*?)\n\}/g)) {
    const body = match[2]!;
    found.set(match[1]!, { keys: new Set([...body.matchAll(/^ {2}(\w+)\??:/gm)].map((key) => key[1]!)), any: /^ {2}\[\w+: string\]/m.test(body) });
  }
  return found;
}

function presetComponents(): { name: string; allowed: Record<string, string> }[] {
  const preset = fromMail('mjml-preset-core') as { components?: any[]; default?: { components: any[] } };
  const list = (preset.components ?? preset.default!.components) as { componentName: string; allowedAttributes?: Record<string, string> }[];
  return list.map((component) => ({ name: component.componentName, allowed: component.allowedAttributes ?? {} }));
}

describe('the library under the components', () => {
  it('is pinned exactly, and is the version installed', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(library.version).toBe(pinned);
  });

  /** `^x.y.z` and nothing else: a range this test cannot read would pass anything. */
  const caret = (range: string) => {
    const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
    if (!match) throw new Error(`${range} is not a caret range (^x.y.z): the compatibility test reads no other form`);
    return match.slice(1).map(Number) as [number, number, number];
  };
  const satisfies = (version: string, range: string) => {
    const [major, minor, patch] = caret(range);
    const [a, b, c] = version.split('.').map(Number) as [number, number, number];
    return a === major && (b > minor || (b === minor && c >= patch));
  };

  it('allows the mjml that @marmeon/mail asks for at the least, and the one installed', () => {
    const range = library.peerDependencies.mjml as string;
    const asked = read('packages/mail/package.json').peerDependencies.mjml as string;
    const [major, minor, patch] = caret(asked);
    expect(satisfies(`${major}.${minor}.${patch}`, range), `${LIBRARY} asks for mjml ${range}, @marmeon/mail for ${asked}`).toBe(true);
    expect(satisfies(installed, range), `${LIBRARY} asks for mjml ${range}, ${installed} is installed`).toBe(true);
  });

  it('reads only caret ranges', () => {
    expect(() => caret('>=5')).toThrow('not a caret range');
    expect(() => caret('~5.0.0')).toThrow('not a caret range');
    expect(() => caret('5.x')).toThrow('not a caret range');
    expect(satisfies('5.4.1', '^5.0.0')).toBe(true);
    expect(satisfies('6.0.0', '^5.0.0')).toBe(false);
    expect(satisfies('5.0.0', '^5.1.0')).toBe(false);
  });
});

describe('the components against MJML', () => {
  const preset = presetComponents();

  it('wrap every tag of mjml-preset-core but those with a reason, and no tag MJML does not have', () => {
    const tags = new Set([...preset.map((component) => component.name), 'mjml', 'mj-all', 'mj-class', 'mj-selector', 'mj-html-attribute']);
    expect([...tags].filter((tag) => !wrapped.has(tag) && !(tag in NOT_WRAPPED)).sort()).toEqual([]);
    expect([...wrapped.keys()].filter((tag) => !tags.has(tag)).sort()).toEqual([]);
    expect(Object.keys(NOT_WRAPPED).filter((tag) => wrapped.has(tag))).toEqual([]);
  });

  it('take every attribute MJML lists for a tag, except the known gaps — and the gaps are real', () => {
    const declared = declaredProps();
    const missing: Record<string, string[]> = {};
    for (const component of preset) {
      const name = wrapped.get(component.name);
      if (name === undefined) continue;
      const props = declared.get(name)!;
      const gaps = Object.keys(component.allowed).filter((attribute) => !props.any && !props.keys.has(camel(attribute)));
      if (gaps.length > 0) missing[component.name] = gaps.map(camel).sort();
    }
    // The root tag lists nothing; mjml-core reads these from it.
    const core = readFileSync(fromMail.resolve('mjml-core/lib/index.js'), 'utf8');
    const root = [...core.matchAll(/get\)\(mjml, 'attributes\.(\w+)'/g)].map((match) => match[1]!);
    expect(root.sort()).toEqual(['dir', 'lang', 'owa']);
    const props = declared.get('MjmlDocument')!;
    const lacking = root.filter((attribute) => !props.keys.has(attribute));
    if (lacking.length > 0) missing.mjml = lacking;
    expect(missing).toEqual(Object.fromEntries(Object.entries(KNOWN_GAPS).map(([tag, attributes]) => [tag, [...attributes]])));
  });

  it('take nothing MJML does not know on a tag, but the names of a class', () => {
    const declared = declaredProps();
    const extra: Record<string, string[]> = {};
    for (const component of preset) {
      const name = wrapped.get(component.name);
      if (name === undefined) continue;
      const known = new Set(Object.keys(component.allowed).map(camel));
      const unknown = [...declared.get(name)!.keys].filter((key) => key !== 'children' && key !== 'dangerouslySetInnerHTML' && !OWN.has(key) && !known.has(key));
      if (unknown.length > 0) extra[component.name] = unknown;
    }
    expect(extra).toEqual({});
  });

  it('takes a number as px for exactly the props typed string | number', () => {
    const text = readFileSync(join(root, 'packages/react/src/mail/props.ts'), 'utf8');
    const typed = new Set([...text.matchAll(/^ {2}(\w+)\?: string \| number;/gm)].map((match) => match[1]!));
    expect([...UNIT_PROPS].sort()).toEqual([...typed].sort());
  });
});
