import { describe, expect, it } from 'vitest';
import { CHAIN } from './chain.ts';
import { SiteSnippets } from './SiteSnippets.ts';

describe('SiteSnippets', () => {
  it('throws before load() and answers the chain in the order of CHAIN after it', async () => {
    const snippets = new SiteSnippets();
    expect(() => snippets.all()).toThrow('not loaded yet');
    expect(() => snippets.chain()).toThrow('not loaded yet');
    await snippets.load();
    expect(snippets.chain().map((step) => step.id)).toEqual(CHAIN.map((step) => step.id));
    expect(Object.keys(snippets.all())).toContain(CHAIN[0]!.snippet);
  });
});
