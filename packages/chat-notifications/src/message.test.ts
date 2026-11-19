import { describe, expect, it } from 'vitest';
import { ChatError } from './errors.ts';
import { normalizeMessage } from './message.ts';

const secret = ['sec', 'ret', '-', 'value', '-', 'x'.repeat(12)].join('');

function refusal(input: unknown): string {
  try {
    normalizeMessage(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ChatError);
    return (error as ChatError).message;
  }
  throw new Error('expected a refusal');
}

describe('normalizeMessage: caps', () => {
  it('cuts title, text, field label and value, and link label at their caps, ending in an ellipsis', () => {
    const { content } = normalizeMessage({
      to: 'ops',
      title: 'a'.repeat(200),
      text: 'b'.repeat(3000),
      fields: [{ label: 'c'.repeat(80), value: 'd'.repeat(400) }],
      links: [{ label: 'e'.repeat(120), url: 'https://example.com/' }],
    });
    expect(Array.from(content.title ?? '')).toHaveLength(150);
    expect(Array.from(content.text)).toHaveLength(2000);
    expect(Array.from(content.fields[0]?.label ?? '')).toHaveLength(50);
    expect(Array.from(content.fields[0]?.value ?? '')).toHaveLength(300);
    expect(Array.from(content.links[0]?.label ?? '')).toHaveLength(75);
    for (const cut of [content.title, content.text, content.fields[0]?.label, content.fields[0]?.value, content.links[0]?.label]) {
      expect(cut?.endsWith('…')).toBe(true);
    }
  });

  it('keeps a text at its cap whole and cuts one code point more', () => {
    expect(normalizeMessage({ to: 'ops', text: 'x'.repeat(2000) }).content.text).toBe('x'.repeat(2000));
    expect(normalizeMessage({ to: 'ops', text: 'x'.repeat(2001) }).content.text).toBe(`${'x'.repeat(1999)}…`);
  });

  it('never splits a four-byte character at the boundary', () => {
    const { content } = normalizeMessage({ to: 'ops', title: `${'a'.repeat(148)}😀😀😀`, text: 'x' });
    const title = content.title ?? '';
    expect(Array.from(title)).toHaveLength(150);
    expect(title).toBe(`${'a'.repeat(148)}😀…`);
    expect(title.isWellFormed()).toBe(true);
    const exact = normalizeMessage({ to: 'ops', title: `${'a'.repeat(149)}😀`, text: 'x' }).content.title;
    expect(exact).toBe(`${'a'.repeat(149)}😀`);
  });
});

describe('normalizeMessage: sanitizing', () => {
  it('strips NUL, bidi overrides and isolates, DEL and C1 controls but keeps newline and tab', () => {
    const { content } = normalizeMessage({ to: 'ops', text: 'a\u0000b\u202Ec\u2066d\u200Fe\u007Ff\u0085g\r\nh\ri\tj\nk' });
    expect(content.text).toBe('abcdefg\nh\ni\tj\nk');
  });

  it('strips every control and bidirectional control character from every text, and keeps newline and tab in a text', () => {
    const stripped: string[] = [];
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      if (/\p{Bidi_Control}/u.test(char) || (/\p{Cc}/u.test(char) && char !== '\n' && char !== '\t' && char !== '\r')) stripped.push(char);
    }
    // a carriage return is a line break, not stripped (see the test of line breaks)
    expect(stripped.length).toBeGreaterThan(60);
    const all = stripped.join('');
    const { content } = normalizeMessage({
      to: 'ops',
      title: `t${all}t`,
      text: `a${all}b\n\tc`,
      fields: [{ label: `l${all}l`, value: `v${all}v` }],
      links: [{ label: `k${all}k`, url: 'https://example.com/' }],
    });
    expect(content.title).toBe('tt');
    expect(content.text).toBe('ab\n\tc');
    expect(content.fields[0]).toEqual({ label: 'll', value: 'vv' });
    expect(content.links[0]?.label).toBe('kk');
    expect(stripped).toContain('\u061C');
  });

  it('keeps a zero-width joiner, as emoji sequences are built with it', () => {
    expect(normalizeMessage({ to: 'ops', text: '\u{1F468}\u200D\u{1F469}' }).content.text).toBe('\u{1F468}\u200D\u{1F469}');
  });

  it('trims the end before the ellipsis, and trims a field value and a link label', () => {
    const cut = normalizeMessage({ to: 'ops', text: 'x', title: `${'a'.repeat(148)} bcd` }).content.title;
    expect(cut).toBe(`${'a'.repeat(148)}…`);
    const { content } = normalizeMessage({
      to: 'ops',
      text: 'x',
      fields: [{ label: 'l', value: ' v ' }],
      links: [{ label: 'two\nlines', url: 'https://example.com/' }],
    });
    expect(content.fields[0]?.value).toBe('v');
    expect(content.links[0]?.label).toBe('two lines');
  });

  it('replaces a lone surrogate in every text and in raw strings and keys', () => {
    const lone = 'a\uD800b';
    const { content } = normalizeMessage({
      to: 'ops',
      title: lone,
      text: lone,
      fields: [{ label: lone, value: lone }],
      links: [{ label: lone, url: 'https://example.com/' }],
      raw: { x: { [lone]: lone } },
    });
    const raw = content.raw?.['x'] as Record<string, string>;
    const texts = [content.title, content.text, content.fields[0]?.label, content.fields[0]?.value, content.links[0]?.label, Object.keys(raw)[0], Object.values(raw)[0]];
    for (const text of texts) {
      expect(text?.isWellFormed()).toBe(true);
      expect(text).toContain('\uFFFD');
    }
  });

  it('collapses newlines and whitespace runs of a title into one space', () => {
    expect(normalizeMessage({ to: 'ops', title: '  one\n\ntwo \t three\r\n', text: 'x' }).content.title).toBe('one two three');
  });

  it('leaves out a title that is empty after cleaning, and keeps an empty field value', () => {
    const { content } = normalizeMessage({ to: 'ops', title: ' \u202E ', text: 'x', fields: [{ label: 'l', value: '' }] });
    expect(content).not.toHaveProperty('title');
    expect(content.fields).toEqual([{ label: 'l', value: '' }]);
  });

  it('returns the destination and defaults fields and links to empty lists', () => {
    const { to, content } = normalizeMessage({ to: { url: 'https://example.com/x', driver: 'teams' }, text: 'hi' });
    expect(to).toEqual({ url: 'https://example.com/x', driver: 'teams' });
    expect(content).toEqual({ text: 'hi', fields: [], links: [] });
  });
});

describe('normalizeMessage: refusals', () => {
  it('refuses what is not an object', () => {
    for (const input of [undefined, null, 'text', 3, ['x']]) expect(refusal(input)).toContain('must be an object');
  });

  it('names the field of a wrong shape and never its value', () => {
    expect(refusal({ to: 'ops', text: 1, title: secret })).toContain('"text"');
    expect(refusal({ to: 'ops', text: 'x', title: { secret } })).toContain('"title"');
    expect(refusal({ to: 'ops', text: 'x', title: { secret } })).not.toContain(secret);
    expect(refusal({ to: 'ops', text: 'x', fields: [{ label: 'l', value: 3 }] })).toContain('fields[0].value');
    expect(refusal({ to: 'ops' })).toContain('"text" is required');
  });

  it('refuses a text that is empty after trimming, control characters included', () => {
    expect(refusal({ to: 'ops', text: ' \n\u202E\u0000 ' })).toContain('"text"');
  });

  it('refuses a "to" that is neither a name nor a plain object with a url', () => {
    expect(refusal({ text: 'x' })).toContain('"to"');
    expect(refusal({ to: '  ', text: 'x' })).toContain('"to"');
    expect(refusal({ to: { url: 3 }, text: 'x' })).toContain('"to.url"');
    expect(refusal({ to: { url: '' }, text: 'x' })).toContain('"to.url"');
    expect(refusal({ to: { url: `https://example.com/${'p'.repeat(2000)}` }, text: 'x' })).toContain('"to.url"');
    expect(refusal({ to: ['https://x.example'], text: 'x' })).toContain('"to"');
    expect(refusal({ to: new (class Target { url = 'https://example.com/' })(), text: 'x' })).toContain('plain object');
    const message = refusal({ to: { url: secret, driver: `Bad ${secret}` }, text: 'x' });
    expect(message).toContain('"to.driver"');
    expect(message).not.toContain(secret);
  });

  it('refuses a destination name outside the name grammar, naming "to" and not the value, and accepts a name inside it', () => {
    const slackUrl = ['https://hooks.slack.com/services', 'T0', 'B0', 'x'.repeat(24)].join('/');
    for (const to of ['Ops', 'ops ', ' ops', 'o ps', slackUrl, `Secret_${secret}`, '1ops', '']) {
      const message = refusal({ to, text: 'x' });
      expect(message, to).toContain('"to"');
      if (to !== '') expect(message).not.toContain(to);
    }
    expect(normalizeMessage({ to: 'ops-2', text: 'x' }).to).toBe('ops-2');
    expect(refusal({ to: { url: 'https://example.com/x', driver: 'Teams' }, text: 'x' })).toContain('"to.driver"');
  });

  it('refuses more than ten fields and more than five links, and accepts exactly those counts', () => {
    const field = { label: 'l', value: 'v' };
    const link = { label: 'l', url: 'https://example.com/' };
    expect(normalizeMessage({ to: 'ops', text: 'x', fields: Array(10).fill(field), links: Array(5).fill(link) }).content.fields).toHaveLength(10);
    expect(refusal({ to: 'ops', text: 'x', fields: Array(11).fill(field) })).toContain('"fields"');
    expect(refusal({ to: 'ops', text: 'x', links: Array(6).fill(link) })).toContain('"links"');
  });

  it('refuses an empty field label and an empty link label', () => {
    expect(refusal({ to: 'ops', text: 'x', fields: [{ label: ' ', value: 'v' }] })).toContain('fields[0].label');
    expect(refusal({ to: 'ops', text: 'x', links: [{ label: '', url: 'https://example.com/' }] })).toContain('links[0].label');
  });

  it('refuses a link that does not parse, is not http(s) or carries credentials, naming the field and not the address', () => {
    const cases: [string, string][] = [
      [secret, 'is not an address'],
      [`ftp://example.com/${secret}`, 'must use http or https'],
      [`javascript:${secret}`, 'must use http or https'],
      [`https://user:${secret}@example.com/`, 'must not carry credentials'],
      [`https://:${secret}@example.com/`, 'must not carry credentials'],
      [`https://${secret}@example.com/`, 'must not carry credentials'],
    ];
    for (const [url, part] of cases) {
      const message = refusal({ to: 'ops', text: 'x', links: [{ label: 'l', url }] });
      expect(message, part).toContain(`links[0].url" ${part}`);
      expect(message).not.toContain(secret);
    }
    const ok = normalizeMessage({ to: 'ops', text: 'x', links: [{ label: 'l', url: 'http://example.com' }] });
    expect(ok.content.links[0]?.url).toBe('http://example.com/');
  });

  it('leaves out a link whose address is longer than 2000 characters and keeps the others', () => {
    const good = { label: 'good', url: 'https://example.com/ok' };
    const { content } = normalizeMessage({ to: 'ops', text: 'x', links: [{ label: 'long', url: `https://example.com/${'p'.repeat(1981)}` }, good] });
    expect(content.links).toEqual([{ label: 'good', url: 'https://example.com/ok' }]);
    const spaced = normalizeMessage({ to: 'ops', text: 'x', links: [{ label: 'enc', url: `https://example.com/${'é '.repeat(500)}${secret}` }, good] });
    expect(spaced.content.links).toHaveLength(1);
    // a long input that parses to a short address is left out too: the input is bounded
    const padded = normalizeMessage({ to: 'ops', text: 'x', links: [{ label: 'tabs', url: `https://example.com/ok${'\t'.repeat(2100)}` }, good] });
    expect(padded.content.links).toEqual([{ label: 'good', url: 'https://example.com/ok' }]);
    expect(JSON.stringify(spaced)).not.toContain(secret);
  });

  it('measures the length of a link after percent-encoding', () => {
    const url = `https://example.com/${'é'.repeat(400)}`;
    expect(url.length).toBeLessThan(2000);
    expect(normalizeMessage({ to: 'ops', text: 'x', links: [{ label: 'l', url }] }).content.links).toHaveLength(0);
    expect(normalizeMessage({ to: 'ops', text: 'x', links: [{ label: 'l', url: `https://example.com/${'a'.repeat(1980)}` }] }).content.links).toHaveLength(1);
  });

  it('refuses a raw value that is not a plain object of JSON values, saying why', () => {
    class Sub extends Array {}
    const sparse = [1];
    sparse[2] = 3;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, 0, { get: () => 1, enumerable: true });
    const bare = Object.setPrototypeOf([], null) as unknown[];
    const cases: [unknown, string][] = [
      [[], 'must be a plain object'],
      ['text', 'must be a plain object'],
      [{ slack: { at: new Date(0) } }, 'not a plain one'],
      [{ slack: { run: () => 1 } }, 'not JSON (function)'],
      [{ slack: new Map() }, 'not a plain one'],
      [{ slack: new (class Thing {})() }, 'not a plain one'],
      [{ slack: { n: Number.NaN } }, 'not finite'],
      [{ slack: { n: Infinity } }, 'not finite'],
      [{ slack: sparse }, 'not JSON (undefined)'],
      [{ slack: { n: 10n } }, 'not JSON (bigint)'],
      [{ slack: { [Symbol('s')]: 1 } }, 'not a plain one'],
      [{ slack: { get x() { return 1; } } }, 'a getter'],
      [{ slack: new Sub() }, 'array that is not a plain one'],
      [{ slack: bare }, 'array that is not a plain one'],
      [{ slack: accessor }, 'not JSON (undefined)'],
    ];
    for (const [raw, part] of cases) {
      const message = refusal({ to: 'ops', text: 'x', raw });
      expect(message, part).toContain(part);
      expect(message).toContain('"raw"');
    }
  });

  it('accepts 64 levels of nesting and refuses 65', () => {
    const nest = (levels: number): unknown => {
      let value: unknown = 1;
      for (let index = 0; index < levels; index += 1) value = { a: value };
      return value;
    };
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: nest(64) }).content.raw).toBeDefined();
    expect(refusal({ to: 'ops', text: 'x', raw: nest(65) })).toContain('nested deeper than 64');
  });

  it('does not put a refused raw value into the message', () => {
    expect(refusal({ to: 'ops', text: 'x', raw: { slack: { [secret]: new Date(0) } } })).not.toContain('secret-value');
  });
});

describe('normalizeMessage: undefined properties of raw', () => {
  it('leaves out a property whose value is undefined, as JSON.stringify does', () => {
    const { content } = normalizeMessage({ to: 'ops', text: 'x', raw: { discord: { content: undefined, embeds: [{ title: 't' }] } } });
    const discord = content.raw?.discord as Record<string, unknown>;
    expect(Object.keys(discord)).toEqual(['embeds']);
    expect(JSON.parse(JSON.stringify(content))).toEqual(content);
  });

  it('drops raw when nothing is left of it', () => {
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: { slack: undefined } }).content.raw).toBeUndefined();
    expect('raw' in normalizeMessage({ to: 'ops', text: 'x', raw: { slack: undefined } }).content).toBe(false);
  });

  it('still refuses a getter, even one that returns undefined, and an undefined list item', () => {
    const getter = { get content(): undefined { return undefined; } };
    expect(refusal({ to: 'ops', text: 'x', raw: { discord: getter } })).toContain('getter');
    expect(refusal({ to: 'ops', text: 'x', raw: { discord: { embeds: [undefined] } } })).toContain('not JSON');
  });

  it('counts a skipped property against the node budget', () => {
    const skipped = (count: number): unknown => ({ slack: Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, undefined])) });
    // the raw object and the slack object count 2
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: skipped(9997) }).content.raw).toBeDefined();
    expect(refusal({ to: 'ops', text: 'x', raw: skipped(9999) })).toContain('more than 10000 values');
  });
});

describe('normalizeMessage: raw budgets', () => {
  const raw = (value: unknown): unknown => ({ slack: value });

  it('accepts exactly 10 000 values and refuses 10 001', () => {
    // the raw object, the list and the numbers inside it
    const list = (count: number): number[] => Array.from({ length: count }, () => 1);
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: raw(list(9998)) }).content.raw).toBeDefined();
    expect(refusal({ to: 'ops', text: 'x', raw: raw(list(9999)) })).toContain('"raw" holds more than 10000 values');
  });

  it('refuses a value that shares references by the count', () => {
    let node: unknown = 1;
    for (let index = 0; index < 15; index += 1) node = [node, node];
    expect(refusal({ to: 'ops', text: 'x', raw: raw(node) })).toContain('more than 10000 values');
  });

  it('counts the size as JSON: strings, keys and the numbers, brackets, colons and commas around them', () => {
    expect(refusal({ to: 'ops', text: 'x', raw: raw('a'.repeat(65 * 1024)) })).toContain('larger than 64 KB as JSON');
    expect(refusal({ to: 'ops', text: 'x', raw: { ['k'.repeat(65 * 1024)]: 1 } })).toContain('larger than 64 KB as JSON');
    expect(refusal({ to: 'ops', text: 'x', raw: raw('é'.repeat(33 * 1024)) })).toContain('larger than 64 KB as JSON');
    expect(refusal({ to: 'ops', text: 'x', raw: raw(Array(9000).fill(Number.MAX_VALUE)) })).toContain('larger than 64 KB as JSON');
    expect(refusal({ to: 'ops', text: 'x', raw: raw('\u0000'.repeat(65_000)) })).toContain('larger than 64 KB as JSON');
  });

  it('accepts exactly 64 KB of JSON and refuses one byte more', () => {
    // {"slack":"…"} is 12 bytes around the text
    const at = 64 * 1024 - 12;
    expect(JSON.stringify(raw('a'.repeat(at)))).toHaveLength(64 * 1024);
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: raw('a'.repeat(at)) }).content.raw).toBeDefined();
    expect(refusal({ to: 'ops', text: 'x', raw: raw('a'.repeat(at + 1)) })).toContain('larger than 64 KB as JSON');
  });

  it('counts the commas between list items', () => {
    // 23 characters each, and a comma: 2730 items serialize to 65 531 bytes, 2731 to 65 555
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: raw(Array(2730).fill(Number.MAX_VALUE)) }).content.raw).toBeDefined();
    expect(refusal({ to: 'ops', text: 'x', raw: raw(Array(2731).fill(Number.MAX_VALUE)) })).toContain('larger than 64 KB as JSON');
  });

  it.each([true, false, null])('counts the literal %s, its comma and the brackets of its list, to the byte', (literal) => {
    // {"slack":["…",L,L,…]}: 10 bytes before the list, the text, the literals with a comma each, 2 bytes after
    const count = 4000;
    const text = 64 * 1024 - 14 - (String(literal).length + 1) * count;
    const value = (size: number): unknown => raw(['a'.repeat(size), ...Array(count).fill(literal)]);
    expect(JSON.stringify(value(text))).toHaveLength(64 * 1024);
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: value(text) }).content.raw).toBeDefined();
    expect(refusal({ to: 'ops', text: 'x', raw: value(text + 1) })).toContain('larger than 64 KB as JSON');
  });

  it('counts the commas between object keys, the colons and the braces, to the byte', () => {
    // 400 objects of 20 one-byte keys with one-byte values: 121 bytes each, and a comma in the list
    const one = Object.fromEntries('abcdefghijklmnopqrst'.split('').map((key) => [key, 1]));
    const value = (size: number): unknown => raw(['a'.repeat(size), ...Array.from({ length: 400 }, () => ({ ...one }))]);
    const text = 64 * 1024 - 14 - 122 * 400;
    expect(JSON.stringify(value(text))).toHaveLength(64 * 1024);
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: value(text) }).content.raw).toBeDefined();
    expect(refusal({ to: 'ops', text: 'x', raw: value(text + 1) })).toContain('larger than 64 KB as JSON');
  });

  it('refuses two keys of one object that are the same once normalized', () => {
    expect(refusal({ to: 'ops', text: 'x', raw: raw({ '\uD800': 'a', '\uD801': 'b' }) })).toContain('"raw" holds two keys');
    expect(normalizeMessage({ to: 'ops', text: 'x', raw: raw({ a: 1, b: 2 }) }).content.raw).toBeDefined();
  });
});

describe('normalizeMessage: result', () => {
  it('returns frozen plain JSON that does not follow later changes of the input', () => {
    const input = { to: { url: 'https://example.com/x' }, text: 'hi', fields: [{ label: 'a', value: 'b' }], raw: { slack: { blocks: [{ type: 'divider' }] } } };
    const { to, content } = normalizeMessage(input);
    expect(Object.isFrozen(to)).toBe(true);
    expect(Object.isFrozen(content)).toBe(true);
    expect(Object.isFrozen(content.fields)).toBe(true);
    expect(Object.isFrozen(content.fields[0])).toBe(true);
    expect(Object.isFrozen(content.links)).toBe(true);
    expect(Object.isFrozen(content.raw)).toBe(true);
    const slack = content.raw?.['slack'] as { blocks: readonly unknown[] };
    const blocks = slack.blocks;
    expect(Object.isFrozen(blocks)).toBe(true);
    expect(Object.isFrozen(blocks[0])).toBe(true);
    input.fields[0] = { label: 'changed', value: 'changed' };
    input.raw.slack.blocks.push({ type: 'section' });
    expect(content.fields[0]?.label).toBe('a');
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(content))).toEqual(content);
  });

  it('keeps a "__proto__" key of raw as data', () => {
    const raw = JSON.parse('{"slack":{"__proto__":{"polluted":true}}}') as unknown;
    const { content } = normalizeMessage({ to: 'ops', text: 'x', raw });
    const slack = content.raw?.slack as Record<string, unknown>;
    expect(Object.getPrototypeOf(slack)).toBe(Object.prototype);
    expect(Object.keys(slack)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
