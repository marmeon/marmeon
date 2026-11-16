import { cookieNames, twoFactorCode } from '@marmeon/auth/testing';
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

describe('the recovery codes, answered to a browser without JavaScript', { timeout: 30_000 }, () => {
  async function signedIn() {
    const { session } = cookieNames(app);
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } });
    const cookie = login.cookie(session)!;
    return { session, cookie };
  }

  it('turning the factor on: "Done" is a link to the settings page, the first control of the layer', async () => {
    const { session, cookie } = await signedIn();
    await app.withCookie(session, cookie).post('/settings/two-factor/setup').assertRedirect('/settings/two-factor');
    const setup = (await app.withCookie(session, cookie).navigating().get('/settings/two-factor')).page()!.props.setup as { secret: string };
    const response = await app
      .withCookie(session, cookie)
      .post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'password' }, ...document })
      .assertOk()
      .assertServerRendered();
    const markup = markupOf(response.body);
    expect(markup).toContain('<a href="/settings/two-factor" autofocus="">Done</a>');
    expect(layerOf(markup)).not.toContain('<button type="button"');
    expect(firstControlOf(layerOf(markup))).toBe('<a ');
  });

  it('new codes: the same link', async () => {
    const { session, cookie } = await signedIn();
    await app.withCookie(session, cookie).post('/settings/two-factor/setup').assertRedirect('/settings/two-factor');
    const setup = (await app.withCookie(session, cookie).navigating().get('/settings/two-factor')).page()!.props.setup as { secret: string };
    const confirmed = await app.withCookie(session, cookie).layering().post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'password' } });
    const response = await app
      .withCookie(session, confirmed.cookie(session) ?? cookie)
      .post('/settings/two-factor/recovery-codes', { form: { password: 'password' }, ...document })
      .assertOk()
      .assertServerRendered();
    const markup = markupOf(response.body);
    expect(markup).toContain('<a href="/settings/two-factor" autofocus="">Done</a>');
    expect(layerOf(markup)).not.toContain('<button type="button"');
    expect(firstControlOf(layerOf(markup))).toBe('<a ');
  });
});
