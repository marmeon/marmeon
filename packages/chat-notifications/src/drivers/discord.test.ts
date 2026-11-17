import { describe, expect, it } from 'vitest';
import { ChatError } from '../errors.ts';
import { normalizeMessage } from '../message.ts';
import { discord } from './discord.ts';

const HOSTILE = '@everyone @here <@123> <#1> [x](https://evil.example) **b**\n# h\n- i\n> q\n1. n';

function content(input: Record<string, unknown>) {
  return normalizeMessage({ to: 'ops', ...input }).content;
}

interface Embed {
  title?: string;
  description?: string;
  fields?: { name: string; value: string; inline: boolean }[];
}

function render(input: Record<string, unknown>, raw?: unknown) {
  const request = discord.render(content(input), raw);
  return { request, json: request.json as unknown as { allowed_mentions: { parse: string[] }; embeds: Embed[]; components?: unknown[] } };
}

function embedSize(embed: Embed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

describe('discord driver: injection', () => {
  it('pings nobody: allowed_mentions.parse is empty for the neutral message', () => {
    expect(render({ text: HOSTILE }).json.allowed_mentions).toEqual({ parse: [] });
  });

  it('escapes every special character in title, description, field names and values', () => {
    const { json } = render({ title: HOSTILE, text: HOSTILE, fields: [{ label: '<@123> **b** # h', value: HOSTILE }] });
    const escaped = '@\u200Beveryone @\u200Bhere \\<@123> \\<#1> \\[x\\]\\(https\\://evil.example\\) \\*\\*b\\*\\*\n\\# h\n\\- i\n\\> q\n1\\. n';
    const embed = json.embeds[0] as Embed;
    // title and field name are one line: nothing starts a line there but the first character
    const oneLine = '@\u200Beveryone @\u200Bhere \\<@123> \\<#1> \\[x\\]\\(https\\://evil.example\\) \\*\\*b\\*\\* # h - i > q 1. n';
    expect(embed.title).toBe(oneLine);
    expect(embed.description).toBe(escaped);
    expect(embed.fields?.[0]).toEqual({ name: '\\<@123> \\*\\*b\\*\\* # h', value: escaped, inline: false });
  });

  it('leaves no masked link intact', () => {
    const embed = render({ text: '[click](https://evil.example)' }).json.embeds[0] as Embed;
    expect(embed.description).toBe('\\[click\\]\\(https\\://evil.example\\)');
  });

  it('keeps an address that touches a mention from swallowing the escape, in title, text, field name and field value', () => {
    const data = 'https://x.example<@123>';
    const { json } = render({ title: data, text: data, fields: [{ label: data, value: data }] });
    const embed = json.embeds[0] as Embed;
    const expected = 'https\\://x.example\\<@123>';
    expect([embed.title, embed.description, embed.fields?.[0]?.name, embed.fields?.[0]?.value]).toEqual([expected, expected, expected, expected]);
  });

  it('removes bidirectional and control characters', () => {
    expect((render({ text: 'a\u202Eb\u0007c' }).json.embeds[0] as Embed).description).toBe('abc');
  });
});

describe('discord driver: body', () => {
  it('renders one embed with inline false fields, and a zero width space for an empty value', () => {
    const { json, request } = render({ title: 'T', text: 'x', fields: [{ label: 'A', value: 'b' }, { label: 'C', value: '' }] });
    expect(json.embeds).toEqual([{ title: 'T', description: 'x', fields: [{ name: 'A', value: 'b', inline: false }, { name: 'C', value: '\u200B', inline: false }] }]);
    expect(json.components).toBeUndefined();
    expect(request.search).toBeUndefined();
  });

  it('renders links as link buttons and asks for components', () => {
    const { json, request } = render({ text: 'x', links: [{ label: 'Runbook', url: 'https://example.com/r' }] });
    expect(json.components).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: 'Runbook', url: 'https://example.com/r' }] }]);
    expect(request.search).toEqual({ with_components: 'true' });
  });

  it('shows a link whose address is longer than a button takes as a field, whole when it fits', () => {
    const url = `https://example.com/${'a'.repeat(600)}`;
    const { json } = render({ text: 'x', links: [{ label: 'Long', url }, { label: 'Short', url: 'https://example.com/s' }] });
    const row = json.components?.[0] as { components: { url: string }[] } | undefined;
    expect(row?.components.map((button) => button.url)).toEqual(['https://example.com/s']);
    const field = (json.embeds[0] as Embed).fields?.[0];
    expect(field?.name).toBe('Long');
    expect(field?.value).toBe(`<${url}>`);
  });

  it('shows an address in a field whole between angle brackets, never escaped, whatever it holds', () => {
    for (const path of ['_()[]*~|', '[x](https://evil.example)', "a'b`c"]) {
      const url = `https://example.com/${path}?q=${'a'.repeat(600)}`;
      const href = new URL(url).href;
      const embed = render({ text: 'x', links: [{ label: 'L', url }] }).json.embeds[0] as Embed;
      expect(embed.fields?.[0]?.value).toBe(`<${href}>`);
    }
  });

  it('shows an address of 1022 characters whole and a longer one as an ellipsis without any address or button', () => {
    const fit = `https://example.com/${'a'.repeat(1022 - 'https://example.com/'.length)}`;
    expect(fit).toHaveLength(1022);
    const whole = render({ text: 'x', links: [{ label: 'L', url: fit }] });
    expect((whole.json.embeds[0] as Embed).fields?.[0]?.value).toBe(`<${fit}>`);
    const over = render({ text: 'x', links: [{ label: 'L', url: `${fit}a` }] });
    const field = (over.json.embeds[0] as Embed).fields?.[0];
    expect(field).toEqual({ name: 'L', value: '…', inline: false });
    expect(over.json.components).toBeUndefined();
    expect(over.request.search).toBeUndefined();
  });

  it('shows an address that holds a bracket or a space as an ellipsis (a driver gets content that did not pass the URL parser)', () => {
    for (const tail of ['<x>', '<x', 'a>b', ' x', '\tx']) {
      const url = `https://example.com/${'a'.repeat(600)}${tail}`;
      const request = discord.render({ text: 'x', fields: [], links: [{ label: 'L', url }] }, undefined);
      const embed = (request.json as unknown as { embeds: Embed[] }).embeds[0] as Embed;
      expect(embed.fields?.[0]?.value, JSON.stringify(tail)).toBe('…');
    }
  });

  it('turns the address of the last field into an ellipsis before any other value is cut when the embed is full', () => {
    const link = { label: 'L', url: `https://example.com/${'a'.repeat(880)}` };
    const embed = render({
      title: '*'.repeat(150),
      text: 'x',
      fields: Array.from({ length: 8 }, () => ({ label: '*'.repeat(50), value: '*'.repeat(300) })),
      links: [link],
    }).json.embeds[0] as Embed;
    expect(embed.fields?.at(-1)).toEqual({ name: 'L', value: '…', inline: false });
    expect(JSON.stringify(embed.fields?.at(-1))).not.toContain('https');
    expect(embed.fields?.[0]?.value).toBe('\\*'.repeat(300));
    expect(embedSize(embed)).toBeLessThanOrEqual(6000);
  });

  it('keeps 200 units of the description before any field value is cut, and cuts it further only after the values', () => {
    const wide = '\u{1F600}';
    const fields = Array.from({ length: 10 }, () => ({ label: 'l', value: wide.repeat(300) }));
    const embed = render({ text: 'x'.repeat(2000), fields }).json.embeds[0] as Embed;
    expect(embed.description).toBe(`${'x'.repeat(199)}…`);
    expect(embed.description?.length).toBe(200);
    expect(embedSize(embed)).toBeLessThanOrEqual(6000);
    expect(embed.fields?.[0]?.value).toBe(wide.repeat(300));
    // content the caps would not allow (25 long field names), to reach the last step: one character and the ellipsis
    const crowded = discord.render({ text: 'x'.repeat(2000), fields: Array.from({ length: 25 }, () => ({ label: '*'.repeat(200), value: 'v' })), links: [] }, undefined);
    expect(((crowded.json as unknown as { embeds: Embed[] }).embeds[0] as Embed).description).toBe('x…');
  });

  it('keeps every limit with the worst case: escapable characters, 4-byte characters, all caps full', () => {
    const variants: [string, string][] = [
      ['star', '*'],
      ['4-byte', '😀'],
      ['backslash', '\\'],
    ];
    for (const [name, char] of variants) {
      const { json } = render({
        title: char.repeat(150),
        text: char.repeat(2000),
        fields: Array.from({ length: 10 }, () => ({ label: char.repeat(50), value: char.repeat(300) })),
        links: Array.from({ length: 5 }, () => ({ label: char.repeat(75), url: `https://example.com/${'a'.repeat(1900)}` })),
      });
      const embed = json.embeds[0] as Embed;
      expect(embed.title?.length, name).toBeLessThanOrEqual(256);
      expect(embed.description?.length ?? 0, name).toBeLessThanOrEqual(4096);
      expect(embed.fields?.length, name).toBeLessThanOrEqual(25);
      for (const field of embed.fields ?? []) {
        expect(field.name.length, name).toBeLessThanOrEqual(256);
        expect(field.value.length, name).toBeLessThanOrEqual(1024);
        expect(field.value, name).not.toBe('');
      }
      expect(embedSize(embed), name).toBeLessThanOrEqual(6000);
      const first = json.components?.[0] as { components: { label: string; url: string }[] } | undefined;
      const components = first?.components ?? [];
      for (const button of components) {
        expect(button.label.length, name).toBeLessThanOrEqual(80);
        expect(button.url.length, name).toBeLessThanOrEqual(512);
      }
    }
  });

  it('cuts a button label at 80 units and a title at 256, as near as the characters allow', () => {
    const wide = '\u{1F600}';
    const { json } = render({ title: '*'.repeat(150), text: 'x', links: [{ label: wide.repeat(75), url: 'https://example.com/' }] });
    const row = json.components?.[0] as { components: { label: string }[] };
    expect(row.components[0]?.label.length).toBe(79);
    // escaped pairs of 2 units and the ellipsis: 255 of 256
    expect((json.embeds[0] as Embed).title?.length).toBe(255);
    expect(embedSize(render({ text: 'x'.repeat(2000) }).json.embeds[0] as Embed)).toBe(2000);
  });

  it('cuts a title and a description after escaping, ending in an ellipsis and never inside an escape', () => {
    const embed = render({ title: '*'.repeat(150), text: '*'.repeat(2000) }).json.embeds[0] as Embed;
    expect(embed.title?.length).toBeLessThanOrEqual(256);
    expect(embed.title?.endsWith('…')).toBe(true);
    expect(embed.title?.slice(0, -1).replaceAll('\\*', '')).toBe('');
    expect(embed.description?.length).toBe(4000);
    expect(embed.description?.endsWith('…')).toBe(false);
    // an escaped text that does not fit shortens at an escape boundary
    const long = render({ title: 'x', text: '*'.repeat(2000), fields: Array.from({ length: 10 }, () => ({ label: 'l'.repeat(50), value: 'v'.repeat(300) })) }).json.embeds[0] as Embed;
    expect(embedSize(long)).toBeLessThanOrEqual(6000);
    expect(long.description?.endsWith('…')).toBe(true);
    expect(long.description?.replace(/…$/, '').replaceAll('\\*', '')).toBe('');
  });

  it('shortens the description before the field values, and the values from the last', () => {
    const plain = Array.from({ length: 10 }, (_, index) => ({ label: `l${index}`, value: 'v'.repeat(300) }));
    const first = render({ text: '*'.repeat(2000), fields: plain }).json.embeds[0] as Embed;
    expect(embedSize(first)).toBeLessThanOrEqual(6000);
    expect(first.description?.endsWith('…')).toBe(true);
    expect(first.fields?.every((field) => field.value === 'v'.repeat(300))).toBe(true);
    // filled up to the limit, not cut early
    expect(embedSize(first)).toBeGreaterThanOrEqual(6000 - 5);

    // values alone fill the embed: the description goes, then the last values are cut
    const heavy = Array.from({ length: 10 }, (_, index) => ({ label: `l${index}`, value: '😀'.repeat(300) }));
    const second = render({ text: 'a'.repeat(2000), fields: heavy }).json.embeds[0] as Embed;
    expect(embedSize(second)).toBeLessThanOrEqual(6000);
    expect(embedSize(second)).toBeGreaterThanOrEqual(6000 - 5);
    expect(second.description?.length).toBe(200);
    expect(second.fields?.[0]?.value).toBe('😀'.repeat(300));
    expect(second.fields?.at(-1)?.value.endsWith('…')).toBe(true);
    expect(second.fields?.at(-1)?.value.length).toBeLessThan(600);
  });
});

describe('discord driver: raw', () => {
  const BUTTON = { type: 2, style: 5, label: 'x', url: 'https://example.com/' };
  const ROW = { type: 1, components: [BUTTON] };
  const embeds = [{ title: 'Deploy', description: '<@123> shipped' }];

  it('sends content, embeds and components as written, with no ping unless named', () => {
    const components = [{ type: 1, components: [{ type: 2, style: 5, label: 'x', url: 'https://example.com/' }] }];
    const { json, request } = render({ text: HOSTILE }, { content: '<@123> hi', embeds, components });
    expect(json).toEqual({ allowed_mentions: { parse: [] }, content: '<@123> hi', embeds, components });
    expect(request.search).toEqual({ with_components: 'true' });
  });

  it('names no key of a field the format does not have', () => {
    for (const raw of [{ content: 'x', typo_secret: 1 }, { content: 'x', allowedMentions: { typo_secret: 1 } }]) {
      let message = '';
      try {
        discord.render(content({ text: 'x' }), raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('holds a field the format does not have');
      expect(message).not.toContain('typo_secret');
    }
  });

  it('asks for components only when the raw format has them', () => {
    expect(render({ text: 'x' }, { embeds }).request.search).toBeUndefined();
  });

  it('derives parse from allowedMentions and passes id lists through', () => {
    const mentions = (allowedMentions: unknown) => render({ text: 'x' }, { content: 'hi', allowedMentions }).json.allowed_mentions;
    expect(mentions({ everyone: true, users: 'all', roles: 'all' })).toEqual({ parse: ['everyone', 'users', 'roles'] });
    expect(mentions({ users: ['1'], roles: ['2'] })).toEqual({ parse: [], users: ['1'], roles: ['2'] });
    expect(mentions({ everyone: false })).toEqual({ parse: [] });
    expect(mentions({ users: 'all', roles: ['2'] })).toEqual({ parse: ['users'], roles: ['2'] });
    expect(mentions({})).toEqual({ parse: [] });
  });

  it.each([
    ['nothing', {}, '"raw.discord" must hold content, embeds or components.'],
    ['allowedMentions alone', { allowedMentions: { everyone: true } }, '"raw.discord" must hold content, embeds or components.'],
    ['an empty content', { content: '' }, '"raw.discord.content" must have a length of at least 1.'],
    ['a content of 2001 characters', { content: 'x'.repeat(2001) }, '"raw.discord.content" must have a length of at most 2000.'],
    ['no component', { components: [] }, '"raw.discord.components" must have a length of at least 1.'],
    ['no embed', { embeds: [] }, '"raw.discord.embeds" must have a length of at least 1.'],
    ['11 embeds', { embeds: Array.from({ length: 11 }, () => ({})) }, '"raw.discord.embeds" must have a length of at most 10.'],
    ['6 components', { components: Array.from({ length: 6 }, () => ROW) }, '"raw.discord.components" must have a length of at most 5.'],
    ['101 user ids', { content: 'x', allowedMentions: { users: Array.from({ length: 101 }, () => '1') } }, '"raw.discord.allowedMentions.users" must have a length of at most 100.'],
    ['a stray parse', { content: 'x', allowedMentions: { parse: ['users'] } }, '"raw.discord.allowedMentions" holds a field the format does not have.'],
    ['users any', { content: 'x', allowedMentions: { users: 'any' } }, '"raw.discord.allowedMentions.users" must be "all" or a list.'],
    ['a user id that is a number', { content: 'x', allowedMentions: { users: [5] } }, '"raw.discord.allowedMentions.users[0]" must be a string.'],
    ['an interactive button', { components: [{ type: 1, components: [{ type: 2, style: 1, label: 'x', url: 'https://example.com/' }] }] }, '"raw.discord.components[0].components[0].style" must be 5.'],
    ['a button with a custom_id', { components: [{ type: 1, components: [{ type: 2, style: 5, label: 'x', url: 'https://example.com/', custom_id: 'secret-id' }] }] }, '"raw.discord.components[0].components[0]" holds a field the format does not have.'],
    ['a component that is no row', { components: [{ title: 't' }] }, '"raw.discord.components[0].type" is required.'],
    ['a button of another type', { components: [{ type: 1, components: [{ ...BUTTON, type: 3 }] }] }, '"raw.discord.components[0].components[0].type" must be 2.'],
    ['a row of another type', { components: [{ type: 2, components: [BUTTON] }] }, '"raw.discord.components[0].type" must be 1.'],
    ['a row with a field of its own', { components: [{ type: 1, components: [BUTTON], id: 'secret-id' }] }, '"raw.discord.components[0]" holds a field the format does not have.'],
    ['an empty row', { components: [{ type: 1, components: [] }] }, '"raw.discord.components[0].components" must have a length of at least 1.'],
    ['6 buttons', { components: [{ type: 1, components: Array.from({ length: 6 }, () => BUTTON) }] }, '"raw.discord.components[0].components" must have a length of at most 5.'],
    ['a button without a label', { components: [{ type: 1, components: [{ ...BUTTON, label: '' }] }] }, '"raw.discord.components[0].components[0].label" must have a length of at least 1.'],
    ['a label of 81 characters', { components: [{ type: 1, components: [{ ...BUTTON, label: 'l'.repeat(81) }] }] }, '"raw.discord.components[0].components[0].label" must have a length of at most 80.'],
    ['an address of 513 characters', { components: [{ type: 1, components: [{ ...BUTTON, url: `https://example.com/${'a'.repeat(493)}` }] }] }, '"raw.discord.components[0].components[0].url" must have a length of at most 512.'],
    ['an address that is not http(s)', { components: [{ type: 1, components: [{ ...BUTTON, url: 'javascript:secret-value' }] }] }, '"raw.discord.components[0].components[0].url" must be an http or https address.'],
  ])('refuses %s', (_name, raw, message) => {
    const act = () => discord.render(content({ text: 'x' }), raw);
    expect(act).toThrow(ChatError);
    expect(act).toThrow(message);
  });

  it('accepts the limits themselves', () => {
    const one = { title: 't' };
    const rows = Array.from({ length: 5 }, () => ({ type: 1, components: Array.from({ length: 5 }, () => ({ ...BUTTON, label: 'l'.repeat(80), url: `https://example.com/${'a'.repeat(492)}` })) }));
    expect(() => discord.render(content({ text: 'x' }), { content: 'x'.repeat(2000), embeds: Array.from({ length: 10 }, () => one), components: rows })).not.toThrow();
    expect(() => discord.render(content({ text: 'x' }), { content: 'x', allowedMentions: { users: Array.from({ length: 100 }, () => '1') } })).not.toThrow();
  });

  it.each([
    ['content is a number', { content: 5 }, '"raw.discord.content" must be a string.'],
    ['embeds is a text', { embeds: 'x' }, '"raw.discord.embeds" must be a list.'],
    ['an embed is a list', { embeds: [[]] }, '"raw.discord.embeds[0]" must be an object.'],
    ['an embed is a text', { embeds: ['secret-value'] }, '"raw.discord.embeds[0]" must be an object.'],
    ['the format is no object', 'x', '"raw.discord" must be an object.'],
  ])('throws a ChatError that names the field when %s', (_name, raw, field) => {
    const act = () => discord.render(content({ text: 'x' }), raw);
    expect(act).toThrow(ChatError);
    expect(act).toThrow(field);
  });
});
