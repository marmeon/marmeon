import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig, { PACKAGES } from '../../docs.config.ts';
import { DOCS_CSP } from './DocsServiceProvider.ts';
import { DocsRepository } from './DocsRepository.ts';

/**
 * The link check (instead of checking a static export, E133): every page — the start page, the guides, the packages — renders
 * on the server, and every link on it that stays in the docs leads to a page that exists — and to an anchor that exists on it.
 * A README or guide link that breaks on GitHub breaks here.
 */
let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application, { ssr: true });
}, 60_000);
afterAll(() => app?.close());

const GUIDES = (docsConfig.guides ?? []).map((guide) => `/guides/${guide.slug}`);
const PAGES = ['/', ...GUIDES, ...PACKAGES.map((name) => `/packages/${name}`)];
const html = { headers: { accept: 'text/html' } };

/** The links of the page's content and navigation, and the ids on it — read from the server-rendered markup. */
function scan(body: string): { hrefs: string[]; ids: Set<string> } {
  const main = body.slice(body.indexOf('<div id="app">'));
  const hrefs = [...main.matchAll(/<a [^>]*?href="([^"]*)"/g)].map((match) => decode(match[1]!));
  const ids = new Set([...main.matchAll(/ id="([^"]*)"/g)].map((match) => decode(match[1]!)));
  return { hrefs, ids };
}

const decode = (value: string) => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The scripts of a document the browser would run: every `<script>` but inert data blocks — and every `on…=` handler. */
function executableInline(body: string): string[] {
  const scripts = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes = '']) => !/\bsrc=/.test(attributes) && !/\btype="application\/json"/.test(attributes))
    .map(([script]) => script.slice(0, 120));
  const handlers = [...body.matchAll(/<[a-z][^>]*\son[a-z]+=/gi)].map(([tag]) => tag.slice(0, 120));
  return [...scripts, ...handlers];
}

describe('every page', () => {
  const rendered = new Map<string, { hrefs: string[]; ids: Set<string> }>();
  const inline = new Map<string, string[]>();
  const policies = new Set<string | null>();

  it.each(PAGES)('%s answers 200, rendered on the server, and hydrates', async (path) => {
    const response = await app.get(path, html).assertOk().assertServerRendered().assertHydrates();
    rendered.set(path, scan(response.body));
    inline.set(path, executableInline(response.body));
    policies.add(response.headers.get('content-security-policy'));
  });

  it("runs no inline script — the 'self' policy of a publicly cached page holds without a nonce (E147)", () => {
    expect(inline.size).toBe(PAGES.length);
    expect([...inline].filter(([, found]) => found.length > 0)).toEqual([]);
    // One policy for every page, without a nonce: the body — and so the ETag — is the same for everybody.
    expect([...policies]).toEqual(["script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"]);
    expect(DOCS_CSP.scriptSrc).toEqual(["'self'"]);
  });

  it('links only to pages and anchors that exist (README links as on GitHub)', () => {
    expect(rendered.size).toBe(PAGES.length);
    const broken: string[] = [];
    let internal = 0;
    for (const [path, { hrefs }] of rendered) {
      for (const href of hrefs) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue; // another site
        internal++;
        const [target = '', anchor] = href.split('#') as [string, string | undefined];
        const page = target === '' ? path : target.split('?')[0]!;
        const found = rendered.get(page);
        if (!found) {
          if (page !== '/search') broken.push(`${path}: ${href} — no such page`);
          continue;
        }
        if (anchor !== undefined && anchor !== '' && !found.ids.has(anchor)) broken.push(`${path}: ${href} — no #${anchor} on ${page}`);
      }
    }
    // The broken links as the message too: Vitest shortens the list in its own ("[ Array(1) ]").
    expect(broken, broken.join('\n')).toEqual([]);
    expect(internal).toBeGreaterThan(600);
  });

  it('names only files that exist where a README points at the code (`src/kernel.ts` — code text, no link: E10)', () => {
    const repo = resolve(import.meta.dirname, '../../../..');
    const missing = app.make(DocsRepository).pages().flatMap((page) => page.fileLinks.filter((file) => !existsSync(join(repo, file))).map((file) => `${page.file}: ${file}`));
    expect(missing).toEqual([]);
  });
});
