import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { DocsRepository } from '../docs/DocsRepository.ts';
import { SSR_TEST_TIMEOUT } from '../docs/test-timeouts.ts';
import { expectOriginFromAppUrl } from './origin.test-support.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

const html = { headers: { accept: 'text/html' } };
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The `content`/`href` of every `<meta>`/`<link>` tag that matches, entities decoded. */
function tags(body: string, kind: 'meta' | 'link', key: string, value: string): string[] {
  const attribute = kind === 'meta' ? 'content' : 'href';
  return [...body.matchAll(new RegExp(`<${kind} [^>]*>`, 'g'))]
    .map((match) => match[0])
    .filter((tag) => tag.includes(` ${key}="${value}"`))
    .map((tag) => decode(new RegExp(` ${attribute}="([^"]*)"`).exec(tag)?.[1] ?? ''));
}
const canonicalOf = (body: string) => tags(body, 'link', 'rel', 'canonical');
const og = (body: string, property: string) => tags(body, 'meta', 'property', `og:${property}`);
const descriptionOf = (body: string) => tags(body, 'meta', 'name', 'description');

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server });
}, SSR_TEST_TIMEOUT);
afterAll(() => app?.close());

describe('the head of a page', () => {
  const docs = () => app.make(DocsRepository).pages().filter((page) => !page.pending);
  const fixed = [['/', 'Marmeon', 'website'], ['/docs', 'Documentation', 'website'], ['/imprint', 'Site Notice', 'website'], ['/privacy', 'Privacy Policy', 'website']] as const;

  it.each(fixed)('%s names its description, canonical URL and Open Graph data', async (path, title, type) => {
    const body = (await app.get(path, html).assertOk().assertServerRendered()).body;
    const [description] = descriptionOf(body);
    expect(descriptionOf(body)).toHaveLength(1);
    expect(description!.length).toBeGreaterThanOrEqual(50);
    expect(description!.length).toBeLessThanOrEqual(160);
    expect(canonicalOf(body)).toEqual([`http://localhost${path}`]);
    expect(og(body, 'url')).toEqual([`http://localhost${path}`]);
    expect(og(body, 'description')).toEqual([description]);
    expect(og(body, 'type')).toEqual([type]);
    expect(og(body, 'site_name')).toEqual(['Marmeon']);
    expect(og(body, 'title')).toEqual([title]);
    expect(body).not.toMatch(/twitter:|og:image/);
  }, SSR_TEST_TIMEOUT);

  it('gives every page of the docs its derived description, its title and an article type', async () => {
    const problems: string[] = [];
    for (const page of docs()) {
      const body = (await app.get(page.path, html).assertOk()).body;
      const found = {
        description: descriptionOf(body),
        canonical: canonicalOf(body),
        url: og(body, 'url'),
        title: og(body, 'title'),
        type: og(body, 'type'),
        text: og(body, 'description'),
      };
      const expected = { description: [page.description], canonical: [`http://localhost${page.path}`], url: [`http://localhost${page.path}`], title: [page.title], type: ['article'], text: [page.description] };
      if (JSON.stringify(found) !== JSON.stringify(expected)) problems.push(`${page.path}: ${JSON.stringify(found)}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  }, 120_000);

  it('leaves the query out of the canonical URL', async () => {
    const body = (await app.get('/docs/routing?utm_source=x', html).assertOk()).body;
    expect(canonicalOf(body)).toEqual(['http://localhost/docs/routing']);
    expect(og(body, 'url')).toEqual(['http://localhost/docs/routing']);
  }, SSR_TEST_TIMEOUT);

  it('describes the search but names no canonical URL for it', async () => {
    const body = (await app.get('/docs/search?q=queue', html).assertOk()).body;
    expect(descriptionOf(body)).toHaveLength(1);
    expect(canonicalOf(body)).toEqual([]);
    expect(og(body, 'url')).toEqual([]);
  }, SSR_TEST_TIMEOUT);

  it('names no canonical URL on a page that does not exist', async () => {
    const body = (await app.get('/no/such/page', html).assertNotFound()).body;
    expect(canonicalOf(body)).toEqual([]);
    expect(og(body, 'url')).toEqual([]);
  }, SSR_TEST_TIMEOUT);

  it('takes the origin from APP_URL, not from the request', async () => {
    await expectOriginFromAppUrl('/docs/routing', (response) => canonicalOf(response.body)[0] ?? null, 'https://docs.example/docs/routing', html.headers, server);
    await expectOriginFromAppUrl('/', (response) => canonicalOf(response.body)[0] ?? null, 'https://docs.example/', html.headers, server);
  }, SSR_TEST_TIMEOUT);

  it('shares the site root with a Visit', async () => {
    const props = (await app.navigating().get('/docs/routing').assertOk()).page()!.props;
    expect((props.site as { url: string }).url).toBe('http://localhost/');
  });
});
