import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig from '../../docs.config.ts';
import { DOCS_CSP } from './DocsServiceProvider.ts';
import { DocsRepository } from './DocsRepository.ts';

/**
 * The link check (instead of checking a static export, E133): every page — the start page and the docs — renders on the server,
 * and every link on it that stays in the docs leads to a page that exists — and to an anchor that exists on it. A link of a page
 * that breaks on GitHub breaks here; a link to a package README (a card for npm, no page) is "no such page".
 */
let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application, { ssr: true });
}, 60_000);
afterAll(() => app?.close());

const repo = resolve(import.meta.dirname, '../../../..');

const DOCS = docsConfig.sections.flatMap((section) => section.pages.map((entry) => `/docs/${entry.slug}`));
const PAGES = ['/', ...DOCS];
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

  it('links only to pages and anchors that exist (links as on GitHub)', () => {
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
    // Measured 8 403 (the start page and the 73 pages of the docs; the header's and the navigation's 70-odd links on each page count
    // too). The threshold is that − 10 %: it shows a renderer or a layout that drops the navigation or the content's links on every
    // page — not one page that lost its links (a few dozen of eight thousand), which only the per-link check above can see.
    expect(internal).toBeGreaterThan(7_560);
  });

  it('names only files that exist where a page points at the code (`src/kernel.ts` — code text, no link: E10) — no directory', () => {
    // A directory is no file to name: a link to `../packages/queue/` would stay code text that says nothing — link the docs page.
    const what = (file: string) => (!existsSync(join(repo, file)) ? 'no such file' : statSync(join(repo, file)).isFile() ? undefined : 'a directory, not a file');
    const missing = app.make(DocsRepository).pages().flatMap((page) => page.fileLinks.flatMap((file) => (what(file) ? [`${page.file}: ${file} — ${what(file)}`] : [])));
    expect(missing, missing.join('\n')).toEqual([]);
  });
});

describe('the docs the framework names', () => {
  it('every docs path the framework names leads to a page and its anchor', () => {
    const docs = app.make(DocsRepository);
    const anchorsOf = new Map(docs.pages().map((page) => [page.file, new Set(page.anchors)]));
    const problems: string[] = [];
    let named = 0;
    for (const { path, text } of namingFiles()) {
      text.split('\n').forEach((line, index) => {
        const at = `${path}:${index + 1}`;
        for (const [readme] of line.matchAll(README_PATH)) problems.push(`${at}: ${readme} names a README — the docs live in docs/`);
        for (const [, file = '', hash] of line.matchAll(DOCS_PATH)) {
          named++;
          // What follows `#` up to the end of the reference, a sentence's last full stop or colon aside.
          const anchor = hash?.replace(/[.:!?]+$/, '');
          const anchors = anchorsOf.get(file);
          if (!anchors) problems.push(`${at}: ${file} — no such page of the docs`);
          else if (anchor !== undefined && !SLUG.test(anchor)) problems.push(`${at}: ${file}#${anchor} — no anchor GitHub makes (lower-case letters, digits, - and _)`);
          else if (anchor !== undefined && !anchors.has(anchor)) problems.push(`${at}: ${file}#${anchor} — no #${anchor} on that page`);
        }
      });
    }
    expect(problems, problems.join('\n')).toEqual([]);
    // The solutions, messages and comments that name a page (measured 34): a scan that reads no file would pass with nothing found.
    expect(named).toBeGreaterThan(25);
  });
});

/**
 * A docs page as code names it: `docs/<slug>.md`, maybe with `#` and its anchor. `docs/` is flat — every page is `docs/<slug>.md`,
 * none in a folder — so the path has no `/` after `docs/`. The anchor is everything after `#` up to a space, a quote, a bracket or
 * a comma, so an anchor GitHub cannot make (`#Foo`, `#a.b`, `#${name}`) is caught whole and refused, never cut to a valid prefix.
 */
const DOCS_PATH = /\b(docs\/[a-z0-9-]+\.md)(?:#([^\s`'"()[\]<>,;]*))?/g;
/** An anchor as GitHub makes it from an English heading: lower-case letters, digits, `-` and `_` (`#the-environment-node_env`). */
const SLUG = /^[a-z0-9_-]+$/;
/** A package's README — an npm card, never the place a message or a comment sends anyone to. */
const README_PATH = /packages\/[a-z-]+\/README\.md/g;

/**
 * What reaches apps and their developers and may name a page of the docs: a package's code (`packages/<name>/src`, its tests and
 * fixtures aside), the `make:auth` stubs, the starter's template and the two apps — tracked, or new and not ignored, as git lists them.
 */
function namingFiles(): { path: string; text: string }[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages', 'apps/web-app', 'apps/blank-app'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const wanted = (path: string) =>
    /^packages\/[^/]+\/src\/.+\.tsx?$/.test(path)
      ? !/\.(?:test|type-test)\.tsx?$|__fixtures__\//.test(path)
      : /^(?:packages\/auth\/stubs|packages\/create-marmeon\/template|apps\/web-app|apps\/blank-app)\//.test(path);
  return [...new Set(listed.stdout.split('\0').filter(Boolean))]
    .filter((path) => wanted(path) && existsSync(join(repo, path)))
    .map((path) => ({ path, bytes: readFileSync(join(repo, path)) }))
    .filter(({ bytes }) => !bytes.subarray(0, 8000).includes(0))
    .map(({ path, bytes }) => ({ path, text: bytes.toString('utf8') }));
}
