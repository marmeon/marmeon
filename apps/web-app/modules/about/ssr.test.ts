import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server });
});

const document = { headers: { accept: 'text/html' } };

describe('links on the public pages', () => {
  it('keep the language of the page, and a language switcher leads to the same page in the other one', async () => {
    const response = await app.get('/de/about/features/typed-routes', document).assertOk().assertServerRendered();
    response.assertSee('href="/de/about"'); // the link back: no locale written out
    response.assertSee('<span lang="de" aria-current="true">Deutsch</span>');
    response.assertSee('<a href="/en/about/features/typed-routes" hrefLang="en" lang="en">English</a>');
  });
});
