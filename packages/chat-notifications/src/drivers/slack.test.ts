import { describe, expect, it } from 'vitest';
import { ChatError } from '../errors.ts';
import { normalizeMessage } from '../message.ts';
import { slack } from './slack.ts';

const HOSTILE = '<!channel> <!here> <@U123> <https://evil.example|click> & @here';

function content(input: Record<string, unknown>) {
  return normalizeMessage({ to: 'ops', ...input }).content;
}

function body(input: Record<string, unknown>, raw?: unknown): Record<string, unknown> {
  return slack.render(content(input), raw).json as Record<string, unknown>;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (typeof value === 'object' && value !== null) {
    visit(value as Record<string, unknown>);
    Object.values(value).forEach((item) => walk(item, visit));
  }
}

describe('slack driver: injection', () => {
  it('escapes the fallback text, so no mention or link of the data survives', () => {
    const json = body({ title: HOSTILE, text: HOSTILE, fields: [{ label: HOSTILE, value: HOSTILE }], links: [{ label: HOSTILE, url: 'https://example.com/' }] });
    expect(json.text).toBe(`&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;https://evil.example|click&gt; &amp; @here\n&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;https://evil.example|click&gt; &amp; @here`);
    expect(json.text).not.toMatch(/[<>]/);
  });

  it('sends titles, texts, fields and labels as plain_text objects only: no mrkdwn, no link_names', () => {
    const json = body({ title: HOSTILE, text: HOSTILE, fields: [{ label: HOSTILE, value: HOSTILE }], links: [{ label: HOSTILE, url: 'https://example.com/' }] });
    const types: unknown[] = [];
    walk(json, (node) => {
      expect(node.type).not.toBe('mrkdwn');
      expect(node).not.toHaveProperty('link_names');
      expect(node).not.toHaveProperty('mrkdwn_in');
      if (typeof node.text === 'string' && node !== json) types.push(node.type);
    });
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((type) => type === 'plain_text')).toBe(true);
    expect(json.unfurl_links).toBe(false);
    expect(json.unfurl_media).toBe(false);
  });

  it('removes bidirectional and control characters from escaped data', () => {
    const json = body({ text: 'a\u202Eb\u0007c' });
    expect(json.text).toBe('abc');
  });
});

describe('slack driver: blocks', () => {
  it('renders header, section, fields and buttons', () => {
    const json = body({
      title: 'Disk full',
      text: 'The disk of db-1 is full.',
      fields: [
        { label: 'Host', value: 'db-1' },
        { label: 'Note', value: '' },
      ],
      links: [{ label: 'Runbook', url: 'https://example.com/runbook' }],
    });
    expect(json.blocks).toEqual([
      { type: 'header', text: { type: 'plain_text', text: 'Disk full' } },
      { type: 'section', text: { type: 'plain_text', text: 'The disk of db-1 is full.' } },
      { type: 'section', fields: [{ type: 'plain_text', text: 'Host\ndb-1' }, { type: 'plain_text', text: 'Note' }] },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Runbook' }, url: 'https://example.com/runbook' }] },
    ]);
  });

  it('leaves out the header, fields and actions a message does not have', () => {
    expect((body({ text: 'x' }).blocks as unknown[]).length).toBe(1);
  });

  it('keeps every limit with the worst case: 4-byte characters and all caps full', () => {
    const wide = '😀';
    const json = body({
      title: wide.repeat(200),
      text: wide.repeat(3000),
      fields: Array.from({ length: 10 }, () => ({ label: wide.repeat(60), value: wide.repeat(400) })),
      links: Array.from({ length: 5 }, () => ({ label: wide.repeat(100), url: `https://example.com/${'a'.repeat(1900)}` })),
    });
    const blocks = json.blocks as { type: string; text?: { text: string }; fields?: { text: string }[]; elements?: { text: { text: string }; url: string }[] }[];
    expect(blocks[0]?.text?.text.length).toBeLessThanOrEqual(150);
    expect(blocks[1]?.text?.text.length).toBeLessThanOrEqual(3000);
    for (const field of blocks[2]?.fields ?? []) expect(field.text.length).toBeLessThanOrEqual(2000);
    expect(blocks[2]?.fields).toHaveLength(10);
    for (const button of blocks[3]?.elements ?? []) {
      expect(button.text.text.length).toBeLessThanOrEqual(75);
      expect(button.url.length).toBeLessThanOrEqual(3000);
    }
    expect((json.text as string).length).toBeLessThanOrEqual(4000);
  });

  it('cuts as near to each limit as the escaping allows, not earlier', () => {
    const wide = '\u{1F600}';
    const json = body({
      title: wide.repeat(150),
      text: wide.repeat(2000),
      fields: [{ label: 'l', value: 'v' }],
      links: [{ label: wide.repeat(75), url: 'https://example.com/' }],
    });
    const blocks = json.blocks as { text?: { text: string }; elements?: { text: { text: string } }[] }[];
    // 2 UTF-16 units per character, and the ellipsis: 149 of 150, 2999 of 3000, 75 of 75 for the button label
    expect(blocks[0]?.text?.text.length).toBe(149);
    expect(blocks[1]?.text?.text.length).toBe(2999);
    expect(blocks[3]?.elements?.[0]?.text.text.length).toBe(75);
    const fallback = body({ text: '<'.repeat(2000) }).text as string;
    expect(fallback.length).toBeGreaterThanOrEqual(4000 - 5);
    expect(fallback.length).toBeLessThanOrEqual(4000);
    // a header of exactly 150 and a section of exactly 3000 units stay whole
    const whole = body({ title: 'h'.repeat(150), text: 's'.repeat(2000) }).blocks as { text: { text: string } }[];
    expect(whole[0]?.text.text).toBe('h'.repeat(150));
    expect(whole[1]?.text.text).toBe('s'.repeat(2000));
  });

  it('cuts the fallback after escaping, never inside an entity, with every character escaped', () => {
    const json = body({ title: '&'.repeat(150), text: '<'.repeat(2000) });
    const text = json.text as string;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.endsWith('…')).toBe(true);
    expect(text.slice(0, -1).replaceAll('&amp;', '').replaceAll('&lt;', '').replaceAll('\n', '')).toBe('');
  });
});

describe('slack driver: frozen', () => {
  it('cannot be changed: its hosts and paths are frozen', () => {
    expect(Object.isFrozen(slack)).toBe(true);
    expect(() => (slack.hosts as string[]).push('evil.example')).toThrow(TypeError);
    expect(() => (slack.paths as string[]).push('/x/')).toThrow(TypeError);
  });
});

describe('slack driver: raw', () => {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '<!here> deploy' } }];

  it('replaces the blocks and keeps the escaped fallback and the unfurl settings of the neutral content', () => {
    const json = body({ title: 'T', text: HOSTILE }, { blocks });
    expect(json.blocks).toEqual(blocks);
    expect(json.text).toBe(`T\n&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;https://evil.example|click&gt; &amp; @here`);
    expect(json.unfurl_links).toBe(false);
  });

  it('renders the neutral body when the message has a raw format for another driver only', () => {
    const input = { text: 'x', raw: { discord: { content: 'y' } } };
    const normalized = content(input);
    expect(normalized.raw).toBeDefined();
    expect(slack.render(normalized, undefined)).toEqual(slack.render(content({ text: 'x' }), undefined));
  });

  it.each([
    ['blocks is a text', { blocks: 'x' }, '"raw.slack.blocks"'],
    ['a block has no type', { blocks: [{ text: 'x' }] }, '"raw.slack.blocks[0].type"'],
    ['the format is no object', 'x', '"raw.slack"'],
    ['the format is null', null, '"raw.slack"'],
    ['blocks is missing', {}, '"raw.slack.blocks" is required.'],
    ['a block is a text', { blocks: ['secret-value'] }, '"raw.slack.blocks[0]" must be an object.'],
  ])('throws a ChatError that names the field when %s', (_name, raw, field) => {
    const act = () => slack.render(content({ text: 'x' }), raw);
    expect(act).toThrow(ChatError);
    expect(act).toThrow(field);
  });

  it('refuses a field the format does not have without naming its key', () => {
    const act = () => slack.render(content({ text: 'x' }), { blocks, secret_key_name: 1 });
    expect(act).toThrow(ChatError);
    try {
      act();
    } catch (error) {
      expect((error as Error).message).not.toContain('secret_key_name');
      expect((error as Error).message).toContain('"raw.slack"');
    }
  });
});
