import { createTestApp, startSsrServer, type SsrServer } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { FeatureCatalog } from './FeatureCatalog.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

describe('the public list of features, rendered on the server', () => {
  it('links every feature (each prefetches when it scrolls into view, in the browser) and hydrates', async () => {
    const app = await createTestApp(application, { ssr: true, ssrServer: server });
    const response = await app.get('/en/about', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
    for (const { slug } of new FeatureCatalog().all()) expect(response.body).toContain(`href="/en/about/features/${slug}"`);
  });

  it('renders a feature with its link back, and hydrates', async () => {
    const slug = new FeatureCatalog().all()[0]!.slug;
    const app = await createTestApp(application, { ssr: true, ssrServer: server });
    const response = await app.get(`/en/about/features/${slug}`, { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toContain('href="/en/about"');
  });
});

describe('an instant on a public page', () => {
  const html = { headers: { accept: 'text/html' } };
  const feature = (language: string) => `/${language}/about/features/typed-routes`;

  it('is shown in the app’s time zone (APP_TIMEZONE), and hydrates to the same text', async () => {
    const zoned = await createTestApp(application, { ssr: true, ssrServer: server }); // APP_TIMEZONE of .env.test
    const english = await zoned.get(feature('en'), html).assertOk().assertServerRendered().assertHydrates();
    expect(english.page()!.timeZone).toBe('Europe/Berlin');
    expect(english.body.replaceAll('\u202f', ' ')).toContain('Reviewed at 10:00 AM'); // 09:00 UTC on 2 March
    const german = await zoned.get(feature('de'), html).assertServerRendered().assertHydrates();
    expect(german.body).toContain('Geprüft um 10:00');
  });

  it('follows another zone', async () => {
    const zoned = await createTestApp(application, { ssr: true, ssrServer: server, env: { APP_TIMEZONE: 'America/Los_Angeles' } });
    const response = await zoned.get(feature('en'), html).assertServerRendered().assertHydrates();
    expect(response.body.replaceAll('\u202f', ' ')).toContain('Reviewed at 1:00 AM');
  });
});
