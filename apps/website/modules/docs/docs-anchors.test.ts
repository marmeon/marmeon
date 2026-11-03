import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { headingsOf } from '../../../../packages/cli/src/anchors.ts';
import { renderMarkdown } from './markdown.ts';

const docs = new URL('../../../../docs/', import.meta.url);
const pageOf = (file: string) => /^docs\/([a-z-]+)\.md$/.exec(file)?.[1] && `/${file.slice(0, -3)}`;

// `docs/<page>.md#<anchor>` is a link the framework keeps: the anchors `marmeon mcp` reports are the ids the website renders.
describe('the anchors that marmeon mcp reports', () => {
  it('are the heading ids the website renders, for every heading of every page', () => {
    const pages = readdirSync(docs).filter((name) => name.endsWith('.md'));
    expect(pages.length).toBeGreaterThan(50);
    for (const name of pages) {
      const source = readFileSync(new URL(name, docs), 'utf8');
      const rendered = renderMarkdown(source, { file: `docs/${name}`, pageOf, highlight: (code) => code });
      expect(headingsOf(source).map((heading) => heading.anchor), name).toEqual(rendered.anchors);
    }
  });
});
