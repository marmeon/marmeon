import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import application from '../../bootstrap/app.ts';
import { COMPANY_NAME, COMPANY_URL } from './links.ts';
import { DESCRIPTIONS } from './descriptions.ts';
import { docsNodes, graphBlock, landingNodes, siteNodes, type SiteFacts } from './structured-data.ts';

let server: SsrServer;
let app: TestApp;
let lines: TestApp;
const hostile = '</script><script>alert(1)</script><!-- \u2028 \u2029 &';
const fixture = join(import.meta.dirname, '../docs/__fixtures__/lines');
const html = { headers: { accept: 'text/html' } };

beforeAll(async () => {
  server = await startSsrServer(application);
  app = await createTestApp(application, { ssr: true, ssrServer: server });
  // The line fixture with a page whose Markdown title tries to end the script.
  const root = tempDir('marmeon-structured-data-');
  cpSync(fixture, root, { recursive: true });
  const page = join(root, 'snapshots/0.9.x/docs/routing.md');
  writeFileSync(page, readFileSync(page, 'utf8').replace('# Routing of the line', `# ${hostile}`));
  lines = await createTestApp(application, { env: { DOCS_LINES: join(root, 'snapshots'), DOCS_LINE_PINS: join(root, 'docs-lines.json') }, ssr: true, ssrServer: server });
});
afterAll(async () => {
  await Promise.all([app?.close(), lines?.close(), server?.close()]);
});

const coreVersion = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../packages/core/package.json'), 'utf8')) as { version: string }).version;
const site: SiteFacts = { origin: 'https://marmeon.test', version: '1.2.3', license: 'MIT' };

type Node = Record<string, any>;
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&#39;/g, "'");

/** Every `application/ld+json` block of a document, parsed. */
function blocks(body: string): { '@context': string; '@graph': any[] }[] {
  return [...body.matchAll(/<script [^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]!));
}
const attribute = (body: string, kind: 'meta' | 'link', key: string, value: string, name: string) => {
  const tag = [...body.matchAll(new RegExp(`<${kind} [^>]*>`, 'g'))].map((match) => match[0]).find((found) => found.includes(` ${key}="${value}"`));
  return tag ? decode(new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1] ?? '') : undefined;
};
const titleOf = (body: string) => decode(/<title[^>]*>([^<]*)<\/title>/.exec(body)?.[1] ?? '');

/** Every string in the graph that is a URL: `{ path, value }`. */
function urls(value: unknown, path = ''): { path: string; value: string }[] {
  if (typeof value === 'string') return /^https?:\/\//.test(value) ? [{ path, value }] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => urls(item, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => urls(item, `${path}.${key}`));
  return [];
}
/** The external addresses: only the software node (index 2, pinned by the `@type` assertion) names any. */
const EXTERNAL = /^\[2\]\.(sameAs\[\d+\]|codeRepository|license)$/;

function expectGraph(graph: any[], origin: string, types: string[]) {
  expect(graph.map((node) => node['@type'])).toEqual(types);
  for (const { path, value } of urls(graph)) {
    if (path === '[1].url') expect(value).toBe(COMPANY_URL);
    else if (EXTERNAL.test(path)) expect(value).toMatch(/^https:\/\/(github\.com|www\.npmjs\.com|spdx\.org)\//);
    else expect(new URL(value).origin, path).toBe(origin);
  }
  // Every reference resolves within the graph of its own page.
  const ids = new Set(graph.map((node) => node['@id']));
  const refs = JSON.stringify(graph).match(/"@id":"[^"]+"/g)!.map((found) => found.slice(7, -1));
  for (const id of refs) expect(ids.has(id), id).toBe(true);
}

describe('the structured data builders', () => {
  it('writes the nodes as one @graph block', () => {
    const block = graphBlock(docsNodes(site, { title: 'Routing', description: 'd', path: '/docs/x', version: '1.2.3' }));
    expect(block).toMatchObject({ '@context': 'https://schema.org', '@graph': [{ '@type': 'TechArticle' }, { '@type': 'BreadcrumbList' }] });
  });

  it('numbers the trail from 1 and leaves the last item without a link', () => {
    const [, trail] = docsNodes(site, { title: 'Routing', description: 'd', path: '/docs/routing', version: '1.2.3', line: '0.9.x' });
    const items = trail!['itemListElement'] as Node[];
    expect(items.map((item) => item['position'])).toEqual([1, 2, 3, 4]);
    expect(items.map((item) => item['name'])).toEqual(['Home', 'Docs', '0.9.x', 'Routing']);
    expect(items.map((item) => item['item'])).toEqual(['https://marmeon.test/', 'https://marmeon.test/docs', 'https://marmeon.test/docs/0.9.x', undefined]);
  });

  it('derives the license URL from the SPDX identifier and names no logo, rating or offer', () => {
    const text = JSON.stringify([...siteNodes(site, 'd'), ...landingNodes(site, 'd')]);
    expect(text).toContain('"license":"https://spdx.org/licenses/MIT.html"');
    expect(text).not.toMatch(/logo|aggregateRating|review|offers|SearchAction|dateModified/);
  });
});

describe('the structured data of a page', () => {
  it('describes the landing page with the website, the organization, the software and the page', async () => {
    const body = (await app.get('/', html).assertOk().assertServerRendered()).body;
    const found = blocks(body);
    expect(found).toHaveLength(1);
    const graph = found[0]!['@graph'];
    expectGraph(graph, 'http://localhost', ['WebSite', 'Organization', 'SoftwareSourceCode', 'WebPage']);
    const [website, organization, software, page] = graph;
    expect(software['description']).toBe(attribute(body, 'meta', 'name', 'description', 'content'));
    expect(software['version']).toBe(coreVersion);
    expect(page['description']).toBe(attribute(body, 'meta', 'name', 'description', 'content'));
    expect(organization).not.toHaveProperty('sameAs');
    expect(organization).not.toHaveProperty('logo');
    expect(software['sameAs']).toEqual(['https://www.npmjs.com/package/marmeon']);
    expect(page['url']).toBe(attribute(body, 'link', 'rel', 'canonical', 'href'));
    expect(page['isPartOf']).toEqual({ '@id': website['@id'] });
    expect(page['about']).toEqual({ '@id': software['@id'] });
    expect(website['description']).toBe(DESCRIPTIONS.landing);
  });

  it('describes a page of the docs with its article and its trail', async () => {
    const body = (await app.get('/docs/routing', html).assertOk().assertServerRendered()).body;
    const found = blocks(body);
    expect(found).toHaveLength(1);
    const graph = found[0]!['@graph'];
    expectGraph(graph, 'http://localhost', ['WebSite', 'Organization', 'SoftwareSourceCode', 'TechArticle', 'BreadcrumbList']);
    const article = graph[3];
    expect(article['url']).toBe(attribute(body, 'link', 'rel', 'canonical', 'href'));
    expect(article['@id']).toBe(`${article['url']}#article`);
    expect(article['description']).toBe(attribute(body, 'meta', 'name', 'description', 'content'));
    expect(titleOf(body)).toBe(`${article['headline']} — Marmeon`);
    expect(article['about']).toEqual({ '@id': 'http://localhost/#software' });
    expect(graph[4]['itemListElement'].map((item: Node) => item['position'])).toEqual([1, 2, 3]);
  });

  it('describes a page of a release line with the line as its version and in its trail', async () => {
    const body = (await lines.get('/docs/0.9.x/middleware', html).assertOk().assertServerRendered()).body;
    const found = blocks(body);
    expect(found).toHaveLength(1);
    const graph = found[0]!['@graph'];
    expectGraph(graph, 'http://localhost', ['WebSite', 'Organization', 'SoftwareSourceCode', 'TechArticle', 'BreadcrumbList']);
    const article = graph[3];
    expect(article['version']).toBe('0.9.0');
    expect(article['url']).toBe(attribute(body, 'link', 'rel', 'canonical', 'href'));
    expect(article['description']).toBe(attribute(body, 'meta', 'name', 'description', 'content'));
    expect(titleOf(body)).toBe(`${article['headline']} — Marmeon`);
    expect(graph[4]['itemListElement'].map((item: Node) => item['name'])).toEqual(['Home', 'Docs', '0.9.x', 'Middleware of the line (0.9.x)']);
  });

  it('gives a release-line page identifiers of its own, apart from the newest page', async () => {
    const ids = async (path: string) => blocks((await lines.get(path, html).assertOk().assertServerRendered()).body)[0]!['@graph'].map((node: Node) => node['@id'] as string);
    const line = await ids('/docs/0.9.x/middleware');
    const newest = await ids('/docs/middleware');
    const shared = line.filter((id) => newest.includes(id));
    expect(shared.sort()).toEqual(['http://localhost/#organization', 'http://localhost/#software', 'http://localhost/#website']);
    expect(line).toContain('http://localhost/docs/0.9.x/middleware#article');
    expect(line).toContain('http://localhost/docs/0.9.x/middleware#breadcrumb');
  });

  it('keeps a title that tries to end the script inside the block', async () => {
    const body = (await lines.get('/docs/0.9.x/routing', html).assertOk().assertServerRendered()).body;
    const found = blocks(body);
    expect(found).toHaveLength(1);
    expect(found[0]!['@graph'][3]['headline']).toBe(`${hostile} (0.9.x)`);
    const block = /<script [^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(body)![1]!;
    expect(block).not.toContain('</script');
    expect(block).toContain('\\u003c/script>');
    expect(block).not.toContain('<!--');
    expect(body.match(/<script>alert\(1\)/g)).toBeNull();
  });

  it('takes the origin from APP_URL, not from the request', async () => {
    const other = await createTestApp(application, { env: { APP_URL: 'https://docs.example' }, ssr: true, ssrServer: server });
    try {
      const response = await other.get('/docs/routing', { headers: { ...html.headers, host: 'forged-host.invalid', 'x-forwarded-host': 'forged-host.invalid' } }).assertOk();
      expectGraph(blocks(response.body)[0]!['@graph'], 'https://docs.example', ['WebSite', 'Organization', 'SoftwareSourceCode', 'TechArticle', 'BreadcrumbList']);
      expect(response.body).not.toContain('forged-host.invalid');
    } finally {
      await other.close();
    }
  });

  it('names the operator the legal texts name as the organization', async () => {
    for (const path of ['/imprint', '/privacy']) {
      const body = (await app.get(path, html).assertOk().assertServerRendered()).body;
      const text = /<article class="doc">[\s\S]*?<\/article>/.exec(body)?.[0] ?? '';
      expect(text, path).toContain(`${COMPANY_NAME}<br/>`);
      expect(blocks(body)[0]!['@graph'][1]).toMatchObject({ '@type': 'Organization', '@id': 'http://localhost/#organization', name: COMPANY_NAME, url: COMPANY_URL });
    }
  });

  it("links the organization's URL as the footer links the operator", async () => {
    const body = (await app.get('/imprint', html).assertOk().assertServerRendered()).body;
    expect(body).toContain(`href="${blocks(body)[0]!['@graph'][1]['url']}"`);
  });

  it('writes none on a page that does not exist', async () => {
    const body = (await app.get('/no/such/page', html).assertNotFound()).body;
    expect(blocks(body)).toEqual([]);
  });

  it('writes one block on the other pages too, with the website and the organization', async () => {
    for (const path of ['/docs', '/imprint', '/privacy']) {
      const found = blocks((await app.get(path, html).assertOk()).body);
      expect(found, path).toHaveLength(1);
      expectGraph(found[0]!['@graph'], 'http://localhost', ['WebSite', 'Organization', 'SoftwareSourceCode']);
    }
  });
});
