import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, startSsrServer, type SsrServer } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig, { type DocsPageEntry } from '../../docs.config.ts';
import { DocsError, DocsRepository } from './DocsRepository.ts';
import { ciTimeout, ENTRIES, fileOf, repo } from './docs.test-support.ts';
import { PENDING_MARKER } from './markdown.ts';
import { SSR_TEST_TIMEOUT } from './test-timeouts.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

describe('the repository and docs.config.ts', () => {
  /** A copy of the repository's pages — the real ones are never touched. */
  function copy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'marmeon-website-'));
    mkdirSync(join(dir, 'docs'));
    for (const entry of ENTRIES) cpSync(join(repo, fileOf(entry)), join(dir, fileOf(entry)));
    return dir;
  }

  it('stops the start for a docs/*.md without its entry in a section — and for a listed page whose file is gone', async () => {
    const dir = copy();
    try {
      writeFileSync(join(dir, 'docs/brandnew.md'), '# Brand new\n');
      rmSync(join(dir, 'SECURITY.md'));
      rmSync(join(dir, 'docs/routing.md'));
      const error = await new DocsRepository({ source: dir }).load().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocsError);
      expect((error as DocsError).problems).toEqual([
        `docs.config.ts lists SECURITY.md, but it does not exist in ${dir}.`,
        `docs.config.ts lists docs/routing.md, but it does not exist in ${dir}.`,
        'docs/brandnew.md has no entry in docs.config.ts — add it to a section.',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, ciTimeout);

  it('stops the start for a slug that is no lower-case words with dashes, a slug or a file listed twice, a file of the wrong place and the root README', async () => {
    const extra: DocsPageEntry[] = [
      { slug: 'Routing_Guide', label: 'Routing guide' },
      { slug: 'routing', label: 'Routing again' },
      { slug: 'upgrade', label: 'Upgrade', file: 'UPGRADING.md' },
      { slug: 'notes', label: 'Notes', file: 'packages/core/README.md' },
      { slug: 'other', label: 'Other', file: 'docs/routing.md' },
      { slug: 'readme', label: 'Readme', file: 'README.md' },
    ];
    const docs = { sections: [...docsConfig.sections, { title: 'More', pages: extra }] };
    const error = await new DocsRepository({ source: repo, docs }).load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocsError);
    expect((error as DocsError).problems).toEqual([
      "The page slug 'Routing_Guide' in docs.config.ts is not lower-case words with dashes.",
      "The page slug 'routing' is listed twice in docs.config.ts.",
      'UPGRADING.md is listed twice in docs.config.ts.',
      "The page 'notes' names packages/core/README.md — a page's file is docs/<slug>.md or a Markdown file at the root.",
      "The page 'other' names docs/routing.md — a page's file is docs/<slug>.md or a Markdown file at the root.",
      "The page 'readme' names README.md — the root README is no page of the docs (the start page is the app's own).",
    ]);
  }, ciTimeout);

  it('refuses the slug "search": /docs/search is the search, a page of that name would be hidden by it', async () => {
    const docs = { sections: [...docsConfig.sections, { title: 'More', pages: [{ slug: 'search', label: 'Search' }] }] };
    const error = await new DocsRepository({ source: repo, docs }).load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocsError);
    expect((error as DocsError).problems).toEqual(["The page slug 'search' is reserved — /docs/search is the search."]);
  }, ciTimeout);

  it('marks a page that carries the pending marker in the navigation — and not one without it', async () => {
    const dir = copy();
    try {
      writeFileSync(join(dir, 'docs/routing.md'), '# Routing\n\nWritten.\n');
      writeFileSync(join(dir, 'docs/middleware.md'), `# Middleware\n${PENDING_MARKER}\n\n> [!NOTE]\n> This page is being written.\n`);
      const docs = await new DocsRepository({ source: dir }).load();
      const entries = docs.navigation().groups.flatMap((group) => group.pages);
      expect(entries.find((entry) => entry.name === 'routing')).toEqual({ name: 'routing', label: 'Routing', path: '/docs/routing' });
      expect(entries.find((entry) => entry.name === 'middleware')).toEqual({ name: 'middleware', label: 'Middleware', path: '/docs/middleware', pending: true });
      expect(docs.doc('routing')!.pending).toBe(false);
      expect(docs.doc('middleware')!.pending).toBe(true);
      expect(JSON.stringify(docs.doc('middleware')!.body)).not.toContain('docs:pending');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, ciTimeout);

  it('shows a page with the pending marker as "draft" in the rendered navigation', async () => {
    const dir = copy();
    try {
      writeFileSync(join(dir, 'docs/middleware.md'), `# Middleware\n${PENDING_MARKER}\n\n> [!NOTE]\n> This page is being written.\n`);
      const ssr = await createTestApp(application, { ssr: true, ssrServer: server, env: { DOCS_SOURCE: dir } });
      const { body } = await ssr.get('/docs/routing', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
      expect(body).toMatch(/>Middleware<span class="draft">draft<\/span>/);
      expect(body).not.toMatch(/>Routing<span class="draft">/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SSR_TEST_TIMEOUT);

  it('starts without the packages — their READMEs are no pages', async () => {
    const dir = copy();
    try {
      expect(existsSync(join(dir, 'packages'))).toBe(false);
      const docs = await new DocsRepository({ source: dir }).load();
      expect(docs.pages().map((page) => page.file)).toEqual(ENTRIES.map(fileOf));
      expect(JSON.stringify(docs.navigation())).not.toContain('/packages/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, ciTimeout);

  it('shows raw HTML of a page as text — a <script> never reaches the page as markup (server-rendered)', async () => {
    const dir = copy();
    try {
      appendFileSync(join(dir, 'docs/routing.md'), "\n<script>alert('page')</script>\n\nInline <img src=x onerror=alert(1)> too.\n");
      const ssr = await createTestApp(application, { ssr: true, ssrServer: server, env: { DOCS_SOURCE: dir } });
      const response = await ssr.get('/docs/routing', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
      const content = response.body.slice(response.body.indexOf('<div id="app">'));
      expect(content).toContain('&lt;script&gt;alert(&#x27;page&#x27;)&lt;/script&gt;');
      expect(content).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(content).not.toMatch(/<script>alert|<img src=x/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SSR_TEST_TIMEOUT);

  it('the app does not boot then', async () => {
    const dir = copy();
    try {
      rmSync(join(dir, 'docs/routing.md'));
      await expect(createTestApp(application, { env: { DOCS_SOURCE: dir } })).rejects.toThrow(/docs\.config\.ts lists docs\/routing\.md, but it does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('highlights every code block of every page with the stylesheet’s token classes (no inline colours left)', async () => {
    const docs = await new DocsRepository({ source: repo }).load();
    expect(docs.pages().length).toBe(78);
    // Every colour of every page's code is one of TOKEN_CLASSES (styles/code.css has both themes for them).
    expect(JSON.stringify(docs.pages().map((page) => page.body))).not.toContain('style=');
  });
});
