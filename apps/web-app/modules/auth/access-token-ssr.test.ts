import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

let server: SsrServer;
let app: TestApp;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', ssr: true, ssrServer: server });
}, 30_000);

/** What a browser without JavaScript sends: a form post that asks for HTML and carries no protocol header. */
const document = { headers: { accept: 'text/html' } };
/** The markup of a document: its data blocks (the page object, the islands) cut out, as in docs/testing-pages.md#server-rendering. */
const markupOf = (body: string) => body.replace(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/g, '');
/** The layer's content: from its dialog to the frame's own close button, which comes after it. */
const layerOf = (markup: string) => markup.slice(markup.indexOf('<dialog'), markup.lastIndexOf('<button', markup.indexOf('data-marmeon-layer-close')));

/** The first control in the layer's content: what `showModal()` focuses (the frame's close button comes after it). */
const firstControlOf = (layer: string) => layer.match(/<(?:a|button|input|select|textarea)[\s>]/)?.[0];

describe('a new API token, answered to a browser without JavaScript', { timeout: 30_000 }, () => {
  it('"Done" is a link to the token list, the first control of the layer', async () => {
    const { session } = cookieNames(app);
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } });
    const response = await app
      .withCookie(session, login.cookie(session)!)
      .post('/settings/tokens', { form: { current_password: 'password', name: 'Backup script', abilities: 'users:read' }, ...document })
      .assertOk()
      .assertServerRendered();
    const markup = markupOf(response.body);
    expect(markup).toContain('<a href="/settings/tokens" aria-current="page" data-current="" data-layer-done="" autofocus="">Done — I copied it</a>');
    expect(layerOf(markup)).not.toContain('<button type="button"');
    expect(firstControlOf(layerOf(markup))).toBe('<a ');
  });
});
