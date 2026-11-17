import { describe, expect, it } from 'vitest';
import { ChatError } from '../errors.ts';
import { normalizeMessage } from '../message.ts';
import { teams } from './teams.ts';

function content(input: Record<string, unknown>) {
  return normalizeMessage({ to: 'ops', ...input }).content;
}

function render(input: Record<string, unknown>, raw?: unknown) {
  return teams.render(content(input), raw).json as unknown as { type: string; attachments: { contentType: string; contentUrl: null; content: Card }[] };
}

interface Card {
  type: string;
  version: string;
  body: { type: string; inlines?: { type: string; text: string; weight?: string; size?: string }[] }[];
  actions?: { type: string; title: string; url: string }[];
}

const cardOf = (input: Record<string, unknown>): Card => render(input).attachments[0]?.content as Card;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const LIMIT = 28 * 1024;

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (typeof value === 'object' && value !== null) {
    visit(value as Record<string, unknown>);
    Object.values(value).forEach((item) => walk(item, visit));
  }
}

describe('teams driver: body', () => {
  it('wraps an Adaptive Card in the attachment envelope', () => {
    const json = render({ text: 'x' });
    expect(json.type).toBe('message');
    expect(json.attachments).toHaveLength(1);
    expect(json.attachments[0]).toMatchObject({ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null });
    expect(json.attachments[0]?.content).toMatchObject({ type: 'AdaptiveCard', version: '1.2' });
  });

  it('renders title, lines, fields and links', () => {
    const card = cardOf({
      title: 'Disk full',
      text: 'one\n\ntwo',
      fields: [{ label: 'Host', value: 'db-1' }, { label: 'Note', value: '' }],
      links: [{ label: 'Runbook', url: 'https://example.com/r' }],
    });
    expect(card.body).toEqual([
      { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: 'Disk full', weight: 'Bolder', size: 'Medium' }] },
      { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: 'one' }] },
      { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: '\u200B' }] },
      { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: 'two' }] },
      { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: 'Host: ', weight: 'Bolder' }, { type: 'TextRun', text: 'db-1' }] },
      { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: 'Note', weight: 'Bolder' }] },
    ]);
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Runbook', url: 'https://example.com/r' }]);
  });

  it('uses no element that processes Markdown or mentions: no TextBlock, no FactSet, no msteams entities, <at> literal', () => {
    const json = render({ title: 'T', text: 'x', fields: [{ label: 'a', value: '<at>everyone</at>' }], links: [{ label: 'l', url: 'https://example.com/' }] });
    const types: unknown[] = [];
    const runs: string[] = [];
    walk(json, (node) => {
      types.push(node.type);
      if (node.type === 'TextRun') runs.push(node.text as string);
      expect(node.type).not.toBe('TextBlock');
      expect(node.type).not.toBe('FactSet');
      expect(node).not.toHaveProperty('msteams');
      expect(node).not.toHaveProperty('entities');
    });
    expect(types).toEqual(expect.arrayContaining(['message', 'AdaptiveCard', 'RichTextBlock', 'TextRun', 'Action.OpenUrl']));
    expect(runs).toContain('<at>everyone</at>');
  });

  it('breaks a masked link in every run with a zero width space between ] and (', () => {
    const data = '[x](https://evil.example)';
    const card = cardOf({ title: data, text: data, fields: [{ label: data, value: data }] });
    const texts = card.body.flatMap((element) => element.inlines ?? []).map((run) => run.text);
    expect(texts.length).toBeGreaterThanOrEqual(4);
    for (const text of texts) {
      expect(text).not.toContain('](');
      expect(text).toContain(']\u200B(');
    }
  });

  it('stays within 28 KB for the worst case of the caps with 4-byte characters', () => {
    const wide = '😀';
    for (const text of ['a' + '\n'.repeat(1998) + 'a', 'a\n'.repeat(1000), wide.repeat(1000)]) {
      const json = render({
        title: wide.repeat(200),
        text,
        fields: Array.from({ length: 10 }, () => ({ label: wide.repeat(60), value: `"${wide.repeat(400)}` })),
        links: Array.from({ length: 5 }, () => ({ label: wide.repeat(100), url: `https://example.com/${'a'.repeat(1900)}` })),
      });
      expect(bytes(json)).toBeLessThanOrEqual(LIMIT);
    }
    const quotes = render({ text: wide.repeat(3000), fields: Array.from({ length: 10 }, () => ({ label: '"'.repeat(60), value: '"'.repeat(400) })) });
    expect(bytes(quotes)).toBeLessThanOrEqual(LIMIT);
  });

  it('shortens the text of a message that would pass 28 KB, ending in an ellipsis, as near to the limit as it can', () => {
    const json = render({ text: Array.from({ length: 2000 }, () => 'a').join('\n') });
    expect(bytes(json)).toBeLessThanOrEqual(LIMIT);
    expect(bytes(json)).toBeGreaterThan(LIMIT - 200);
    const body = json.attachments[0]?.content.body ?? [];
    expect(body.at(-1)?.inlines?.[0]?.text.endsWith('…')).toBe(true);
    expect(body.length).toBeLessThan(2000);
  });

  const wide = '😀';
  const EXPECTED_LINKS = 2;
  const heavy = (links: number, text: string) => ({
    title: wide.repeat(150),
    text,
    fields: Array.from({ length: 10 }, () => ({ label: wide.repeat(50), value: wide.repeat(300) })),
    links: Array.from({ length: links }, (_, index) => ({ label: `${wide.repeat(70)}${index}`, url: `https://a.example/?q=${'\\'.repeat(1970)}${index}` })),
  });

  it('drops links from the last, keeps the text, the title and every field label, when the rest alone passes 28 KB', () => {
    const input = heavy(5, 'The disk of db-1 is full.');
    const json = render(input);
    expect(bytes(json)).toBeLessThanOrEqual(LIMIT);
    const card = json.attachments[0]?.content as Card;
    const runs = card.body.flatMap((element) => element.inlines ?? []).map((run) => run.text);
    expect(runs).toContain('The disk of db-1 is full.');
    expect(runs).toContain(wide.repeat(150));
    expect(runs.filter((run) => run === `${wide.repeat(50)}: `)).toHaveLength(10);
    const actions = card.actions ?? [];
    expect(actions.length).toBeLessThan(5);
    const links = normalizeMessage({ to: 'ops', ...input }).content.links;
    expect(new Set(links.map((link) => link.url)).size).toBe(5);
    expect(actions).toHaveLength(EXPECTED_LINKS);
    expect(actions.map((action) => action.url)).toEqual(links.slice(0, EXPECTED_LINKS).map((link) => link.url));
    expect(actions.map((action) => action.title)).toEqual(links.slice(0, EXPECTED_LINKS).map((link) => link.label));
  });

  it('drops every link when not even one fits next to the rest', () => {
    // values no cap allows, so that one link of 4 KB does not fit but the card does without links
    const content = {
      title: wide.repeat(150),
      text: 'x'.repeat(2000),
      fields: Array.from({ length: 10 }, () => ({ label: wide.repeat(50), value: wide.repeat(560) })),
      links: Array.from({ length: 3 }, (_, index) => ({ label: `l${index}`, url: `https://a.example/?q=${'\\'.repeat(1970)}${index}` })),
    };
    const json = teams.render(content, undefined).json as unknown as { attachments: { content: Card }[] };
    expect(bytes(json)).toBeLessThanOrEqual(LIMIT);
    expect(json.attachments[0]?.content.actions).toBeUndefined();
    const runs = (json.attachments[0]?.content.body ?? []).flatMap((element) => element.inlines ?? []).map((run) => run.text);
    expect(runs).toContain(`${'x'.repeat(199)}…`);
    expect(runs.filter((run) => run === wide.repeat(560))).toHaveLength(10);
  });

  it('keeps 200 characters of a long text while links are dropped', () => {
    const json = render(heavy(5, 'x'.repeat(2000)));
    const runs = (json.attachments[0]?.content.body ?? []).flatMap((element) => element.inlines ?? []).map((run) => run.text);
    const text = runs.find((run) => run.startsWith('x')) ?? '';
    expect(text).toBe(`${'x'.repeat(199)}…`);
    expect(json.attachments[0]?.content.actions?.length ?? 0).toBeLessThan(5);
  });

  it('cuts field values to an ellipsis, then the text below the floor, when links are gone and it still does not fit', () => {
    // a raw ChatContent: values the caps would not allow, to reach the later steps of the ladder
    const content = {
      title: wide.repeat(150),
      text: 'b'.repeat(2000),
      fields: [{ label: 'e', value: '' }, ...Array.from({ length: 10 }, () => ({ label: wide.repeat(50), value: wide.repeat(2500) }))],
      links: [],
    };
    const json = teams.render(content, undefined).json as unknown as { attachments: { content: Card }[] };
    expect(bytes(json)).toBeLessThanOrEqual(LIMIT);
    const runs = (json.attachments[0]?.content.body ?? []).flatMap((element) => element.inlines ?? []).map((run) => run.text);
    expect(runs.some((run) => run === '…')).toBe(true);
    // a field without a value stays a label alone
    expect(runs).toContain('e');
    expect(runs).not.toContain('e: ');
    expect(runs.filter((run) => run.startsWith('b')).length).toBeGreaterThan(0);
    const huge = { ...content, text: 'c'.repeat(2000), fields: Array.from({ length: 10 }, () => ({ label: wide.repeat(50), value: wide.repeat(25_000) })) };
    const second = teams.render(huge, undefined).json as unknown as { attachments: { content: Card }[] };
    expect(bytes(second)).toBeLessThanOrEqual(LIMIT);
  });

  it('cuts the text below its floor of 200 characters only when nothing else is left to cut', () => {
    // labels no cap allows, to leave so little room that even the floor does not fit
    const content = { title: wide.repeat(150), text: 'b'.repeat(2000), fields: Array.from({ length: 10 }, () => ({ label: wide.repeat(660), value: 'v' })), links: [] };
    const json = teams.render(content, undefined).json as unknown as { attachments: { content: Card }[] };
    expect(bytes(json)).toBeLessThanOrEqual(LIMIT);
    const runs = (json.attachments[0]?.content.body ?? []).flatMap((element) => element.inlines ?? []).map((run) => run.text);
    const text = runs.find((run) => run.startsWith('b')) ?? '';
    expect(text.length).toBeGreaterThanOrEqual(2);
    expect(text.length).toBeLessThan(200);
    expect(text.endsWith('…')).toBe(true);
    // the values went first
    expect(runs.filter((run) => run === '…')).toHaveLength(10);
    // a text of one character is kept as it is
    const one = teams.render({ ...content, text: 'b' }, undefined).json as unknown as { attachments: { content: Card }[] };
    expect((one.attachments[0]?.content.body ?? []).flatMap((element) => element.inlines ?? []).some((run) => run.text === 'b')).toBe(true);
  });

  it('always fits and always shows a text run: a seeded fuzz over backslash links, newlines and 4-byte fields', () => {
    let seed = 20_260_101;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = (max: number): number => Math.floor(next() * (max + 1));
    for (let round = 0; round < 60; round += 1) {
      const text = Array.from({ length: pick(2000) + 1 }, () => ['a', '\n', wide, '"', '\\'][pick(4)]).join('');
      const input = {
        title: pick(1) === 0 ? wide.repeat(pick(150) + 1) : undefined,
        text: `x${text}`,
        fields: Array.from({ length: pick(10) }, () => ({ label: wide.repeat(pick(49) + 1), value: ['"', wide, '\n', 'v'][pick(3)]?.repeat(pick(300)) ?? '' })),
        links: Array.from({ length: pick(5) }, () => ({ label: wide.repeat(pick(74) + 1), url: `https://a.example/?q=${'\\'.repeat(pick(1979))}` })),
      };
      const json = render(input);
      expect(bytes(json), `round ${round}`).toBeLessThanOrEqual(LIMIT);
      const card = json.attachments[0]?.content as Card;
      expect(card.body.flatMap((element) => element.inlines ?? []).some((run) => run.text.startsWith('x')), `round ${round}`).toBe(true);
    }
  });
});

describe('teams driver: raw', () => {
  const card = { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: '**bold**' }] };

  it('wraps the raw card in the envelope as written', () => {
    const json = render({ text: 'x' }, { card });
    expect(json.attachments[0]?.content).toEqual(card);
    expect(json.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('throws a ChatError for a raw card larger than 28 KB', () => {
    const big = { ...card, body: [{ type: 'TextBlock', text: 'x'.repeat(LIMIT) }] };
    const act = () => teams.render(content({ text: 'x' }), { card: big });
    expect(act).toThrow(ChatError);
    expect(act).toThrow('larger than the 28 KB Teams accepts');
  });

  it('accepts a raw card whose envelope is exactly 28 KB and refuses one byte more', () => {
    const withText = (length: number) => ({ ...card, body: [{ type: 'TextBlock', text: 'x'.repeat(length) }] });
    const envelopeBytes = (length: number) => bytes(render({ text: 'x' }, { card: withText(length) }));
    const exact = LIMIT - envelopeBytes(0);
    const request = teams.render(content({ text: 'x' }), { card: withText(exact) });
    expect(bytes(request.json)).toBe(LIMIT);
    expect((request.json as { attachments: { content: unknown }[] }).attachments[0]?.content).toEqual(withText(exact));
    expect(() => teams.render(content({ text: 'x' }), { card: withText(exact + 1) })).toThrow('larger than the 28 KB Teams accepts');
  });

  it('names no key of a field the format does not have', () => {
    let message = '';
    try {
      teams.render(content({ text: 'x' }), { card, extra_secret: 1 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('holds a field the format does not have');
    expect(message).not.toContain('extra_secret');
  });

  it.each([
    ['the card is no AdaptiveCard', { card: { ...card, type: 'Other' } }, '"raw.teams.card.type"'],
    ['the card has no body', { card: { type: 'AdaptiveCard', version: '1.5' } }, '"raw.teams.card.body"'],
    ['the card has no version', { card: { type: 'AdaptiveCard', body: [] } }, '"raw.teams.card.version"'],
    ['the format has no card', {}, '"raw.teams.card"'],
    ['the format is no object', 'x', '"raw.teams" must be an object.'],
    ['a body element is a text', { card: { type: 'AdaptiveCard', version: '1.5', body: ['secret-value'] } }, '"raw.teams.card.body[0]" must be an object.'],
  ])('throws a ChatError that names the field when %s', (_name, raw, field) => {
    const act = () => teams.render(content({ text: 'x' }), raw);
    expect(act).toThrow(ChatError);
    expect(act).toThrow(field);
  });
});
