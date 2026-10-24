import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { DocsLines } from './DocsLines.ts';

// The lines the repository pins (docs-lines.json) with the snapshots it holds — none until the first release of a major line is pinned.
const appRoot = join(import.meta.dirname, '../..');
const pinned = existsSync(join(appRoot, 'docs-lines.json')) ? Object.keys((JSON.parse(readFileSync(join(appRoot, 'docs-lines.json'), 'utf8')) as { lines: Record<string, unknown> }).lines) : [];

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
}, 60_000); // boots the website with every pinned line's snapshot
afterAll(() => app?.close());

describe('the pinned release lines', () => {
  it('are exactly the lines the website boots with', () => {
    expect(
      app.make(DocsLines).all().map((line) => line.name).sort(),
    ).toEqual([...pinned].sort());
  });

  it('serve every page, its Markdown and the line’s llms.txt', async () => {
    for (const line of app.make(DocsLines).all()) {
      const pages = line.repository.pages();
      expect(pages.length, `${line.name} has pages`).toBeGreaterThan(0);
      for (const page of pages) {
        await app.get(page.path, { headers: { accept: 'text/html' } }).assertOk();
        await app.get(`${page.path}.md`).assertOk();
      }
      await app.get(`/docs/${line.name}/llms.txt`).assertOk();
      await app.get(`/docs/${line.name}/llms-full.txt`).assertOk();
    }
  }, 120_000); // requests every page of every pinned line, as HTML and as Markdown
});
