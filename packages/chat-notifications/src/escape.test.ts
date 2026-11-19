import { describe, expect, it } from 'vitest';
import { breakMaskedLinks, escapeDiscordMarkdown, escapeSlackText } from './escape.ts';

describe('escapeSlackText', () => {
  it('escapes &, < and > and nothing else', () => {
    expect(escapeSlackText('<!channel> & <@U1> <u|l>')).toBe('&lt;!channel&gt; &amp; &lt;@U1&gt; &lt;u|l&gt;');
    expect(escapeSlackText('*b* _i_ ~s~ `c` # - [x](y) @here "q"')).toBe('*b* _i_ ~s~ `c` # - [x](y) @here "q"');
  });

  it('escapes the ampersand first, so an entity in the data stays text', () => {
    expect(escapeSlackText('&lt;')).toBe('&amp;lt;');
  });

  it('escapes twice when it is applied twice', () => {
    expect(escapeSlackText(escapeSlackText('<'))).toBe('&amp;lt;');
  });

  it('removes bidirectional and control characters, replaces lone surrogates and keeps newline and tab', () => {
    expect(escapeSlackText('a\u202Eb\u2066c\u200Fd\u0000e\u0007f\ud800g\n\th')).toBe('abcdef\uFFFDg\n\th');
  });
});

describe('escapeDiscordMarkdown', () => {
  it.each(['\\', '*', '_', '~', '`', '|', '<', '[', ']', '(', ')'])('escapes %s anywhere', (char) => {
    expect(escapeDiscordMarkdown(`a${char}b`)).toBe(`a\\${char}b`);
  });

  it.each(['#', '-', '>', '+'])('escapes %s at the start of a line only', (char) => {
    expect(escapeDiscordMarkdown(`${char} a`)).toBe(`\\${char} a`);
    expect(escapeDiscordMarkdown(`x\n${char} a`)).toBe(`x\n\\${char} a`);
    expect(escapeDiscordMarkdown(`  ${char} a`)).toBe(`  \\${char} a`);
    expect(escapeDiscordMarkdown(`a ${char} b`)).toBe(`a ${char} b`);
  });

  it('escapes the dot of an ordered list item at the start of a line only', () => {
    expect(escapeDiscordMarkdown('1. a\n22. b')).toBe('1\\. a\n22\\. b');
    expect(escapeDiscordMarkdown('v1.2 and 3.')).toBe('v1.2 and 3.');
  });

  it('turns a mention, a masked link and a heading into text', () => {
    expect(escapeDiscordMarkdown('<@123> [x](https://e.example)\n# h')).toBe('\\<@123> \\[x\\]\\(https\\://e.example\\)\n\\# h');
  });

  it.each([
    ['https://x.example<@123>', 'https\\://x.example\\<@123>'],
    ['https://x.example<#456>', 'https\\://x.example\\<#456>'],
    ['https://x.example<https://evil.example>', 'https\\://x.example\\<https\\://evil.example>'],
    ['steam://run/1<@123>', 'steam\\://run/1\\<@123>'],
    ['https://x.example<[click](https://evil.example)', 'https\\://x.example\\<\\[click\\]\\(https\\://evil.example\\)'],
    ['@everyone @here', '@\u200Beveryone @\u200Bhere'],
    ['@Everyone and a@here', '@\u200BEveryone and a@\u200Bhere'],
  ])('keeps an address next to a mention from swallowing the escape: %s', (input, output) => {
    expect(escapeDiscordMarkdown(input)).toBe(output);
  });

  it('leaves a name that only starts like a group mention alone', () => {
    expect(escapeDiscordMarkdown('@everyon @hero')).toBe('@everyon @hero');
  });

  it('leaves plain text alone', () => {
    expect(escapeDiscordMarkdown('Disk of db-1 is 93% full: see #ops at 10:30.')).toBe('Disk of db-1 is 93% full: see #ops at 10:30.');
  });

  it('escapes twice when it is applied twice', () => {
    expect(escapeDiscordMarkdown(escapeDiscordMarkdown('*'))).toBe('\\\\\\*');
  });

  it('removes bidirectional and control characters, replaces lone surrogates and keeps newline and tab', () => {
    expect(escapeDiscordMarkdown('a\u202Eb\u2066c\u0000d\udc00e\n\tf')).toBe('abcd\uFFFDe\n\tf');
  });
});

describe('breakMaskedLinks', () => {
  it('puts a zero width space between ] and (', () => {
    expect(breakMaskedLinks('[x](https://e.example) [y] (z)')).toBe('[x]\u200B(https://e.example) [y] (z)');
  });
});
