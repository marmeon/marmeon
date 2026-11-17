import { describe, expect, it } from 'vitest';
import { CHAIN } from './chain.ts';
import { dedent, SiteSnippets } from './SiteSnippets.ts';
import { SNIPPETS } from './snippets.ts';

describe('SiteSnippets', () => {
  it('throws before load() and answers the chain in the order of CHAIN after it', async () => {
    const snippets = new SiteSnippets();
    expect(() => snippets.all()).toThrow('not loaded yet');
    expect(() => snippets.chain()).toThrow('not loaded yet');
    await snippets.load();
    expect(snippets.chain().map((step) => step.id)).toEqual(CHAIN.map((step) => step.id));
    expect(Object.keys(snippets.all())).toContain(CHAIN[0]!.snippet);
  });

  it('removes the indentation the lines share and keeps the deeper one, empty lines included', () => {
    expect(dedent('      a();\n\n        b();\n      c();\n')).toBe('a();\n\n  b();\nc();\n');
    expect(dedent('a();\n  b();\n')).toBe('a();\n  b();\n');
    expect(dedent('')).toBe('');
  });

  it('highlights the migration columns from the left edge, though the file indents them', async () => {
    expect(SNIPPETS.migrationColumns.code.startsWith('      table.')).toBe(true);
    const snippets = new SiteSnippets();
    await snippets.load();
    const html = snippets.all().migrationColumns.html;
    const text = html.replaceAll(/<[^>]+>/g, '').replaceAll('&#39;', "'");
    expect(text).toContain("table.foreignId('user_id')");
    for (const line of text.split('\n').filter((candidate) => candidate.trim() !== '')) expect(line, line).not.toMatch(/^\s/);
  });
});
