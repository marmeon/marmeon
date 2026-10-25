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
    const response = await app.get('/about', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
    for (const { slug } of new FeatureCatalog().all()) expect(response.body).toContain(`href="/about/features/${slug}"`);
  });
});
