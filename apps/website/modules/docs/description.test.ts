import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { DocsRepository } from './DocsRepository.ts';
import { DESCRIPTION_MAX, fallbackDescription, summarize } from './description.ts';

describe('summarize', () => {
  it('keeps a short paragraph whole', () => {
    const text = 'Routes map a URL to a controller, and give the pair a name that the rest of the app and the pages can use safely.';
    expect(text.length).toBeLessThan(DESCRIPTION_MAX);
    expect(summarize(text)).toBe(text);
  });

  it('takes both sentences when together they are 110 to 160 characters', () => {
    const first = 'A controller is a class with one method that answers one request, and nothing else.';
    const second = 'It gets its collaborators from the constructor.';
    const joined = `${first} ${second} A third sentence that does not fit into the description any more at all.`;
    expect(summarize(joined)).toBe(`${first} ${second}`);
  });

  it('cuts at a word and ends in an ellipsis when the first sentence is short and more follows', () => {
    const result = summarize(`Short one. ${'word, '.repeat(40)}end.`)!;
    expect(result.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toMatch(/[,;:]…$/);
    expect(result).not.toMatch(/\wwor…$/);
  });

  it('cuts a first sentence longer than the limit', () => {
    const result = summarize(`${'alpha beta gamma '.repeat(20)}delta.`)!;
    expect(result.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(result.endsWith('…')).toBe(true);
    expect(result).toMatch(/(alpha|beta|gamma)…$/);
  });

  it('squeezes line breaks and spaces', () => {
    expect(summarize('One   line\nand   another.')).toBe('One line and another.');
  });

  it('ends a paragraph that leads into a code block with a full stop', () => {
    expect(summarize('Every log entry carries the request as a context object:')).toBe('Every log entry carries the request as a context object.');
  });

  it('has nothing to say about an empty paragraph', () => {
    expect(summarize('')).toBeUndefined();
    expect(summarize(' \n ')).toBeUndefined();
  });

  it('does not end a sentence at "e.g. foo"', () => {
    const text = `Use a name such as e.g. foo for the route, ${'and keep it short and plain '.repeat(6)}so that it reads well in a list of names.`;
    expect(summarize(text)!.startsWith('Use a name such as e.g. foo')).toBe(true);
    expect(summarize(`${text} Another sentence follows here.`)!).toContain('e.g. foo');
  });
});

describe('the description of every page of the docs', () => {
  let app: TestApp;
  // The website reads and parses every page of the docs when it boots: that is this hook's work, not a test's.
  beforeAll(async () => {
    app = await createTestApp(application);
  }, 30_000);
  afterAll(() => app?.close());

  it('is 50 to 160 characters of plain text and none is the fallback', async () => {
    const pages = app.make(DocsRepository).pages();
    expect(pages.length).toBeGreaterThan(60);
    const problems = pages.flatMap((page) => {
      const text = page.description;
      const wrong = text.length < 50 || text.length > DESCRIPTION_MAX || text === fallbackDescription(page.title, page.section) || /`|\]\(|\n/.test(text);
      return wrong ? [`${page.name}: ${text}`] : [];
    });
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('starts with the first sentence of the page', async () => {
    expect(app.make(DocsRepository).doc('csrf')!.description).toMatch(/^Cross-site request forgery is a page on another site that makes a visitor's browser send a request to your app\./);
  });
});
