import { twoFactorCode } from '@marmeon/auth/testing';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

// The recovery codes of an editor, answered to a browser without JavaScript: a document with the layer over the security page, whose "Done" must work
// as a plain link.
let server: SsrServer;
let app: TestApp;
beforeAll(async () => {
  await warmUpDatabase();
  server = await startSsrServer(application);
}, WARM_UP_TIMEOUT);
afterAll(() => server?.close());
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true, ssr: true, ssrServer: server });
}, 30_000);
afterEach(() => app.close());

/** What a browser without JavaScript sends: a form post that asks for HTML and carries no protocol header. */
const document = { headers: { accept: 'text/html' } };
/** The markup of a document: its data blocks (the page object, the islands) cut out, as in docs/testing-pages.md#server-rendering. */
const markupOf = (body: string) => body.replace(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/g, '');
/** The layer's content: from its dialog to the frame's own close button, which comes after it. */
const layerOf = (markup: string) => markup.slice(markup.indexOf('<dialog'), markup.lastIndexOf('<button', markup.indexOf('data-marmeon-layer-close')));

/** The first control in the layer's content: what `showModal()` focuses (the frame's close button comes after it). */
const firstControlOf = (layer: string) => layer.match(/<(?:a|button|input|select|textarea)[\s>]/)?.[0];

describe('the recovery codes of an editor, answered to a browser without JavaScript', { timeout: 30_000 }, () => {
  async function editor() {
    const as = app.keepingCookies();
    await as.post('/office/login', { form: { email: 'eve@office.example.com', password: 'password' } });
    await as.post('/office/security/two-factor/setup').assertRedirect('/office/security');
    // The key is shown as text on the page that began the setup.
    const secret = markupOf((await as.get('/office/security', document).assertOk()).body).match(/\b[A-Z2-7]{32}\b/)?.[0];
    expect(secret, 'the security page shows the key').toBeDefined();
    return { as, secret: secret! };
  }

  it('turning the factor on: "Done" is a link to the security page, the first control of the layer', async () => {
    const { as, secret } = await editor();
    const response = await as
      .post('/office/security/two-factor/confirm', { form: { code: twoFactorCode(secret), password: 'password' }, ...document })
      .assertOk()
      .assertServerRendered();
    const markup = markupOf(response.body);
    expect(markup).toContain('<a href="/office/security" autofocus="">Done</a>');
    expect(layerOf(markup)).not.toContain('<button type="button"');
    expect(firstControlOf(layerOf(markup))).toBe('<a ');
  });

  it('new codes: the same link', async () => {
    const { as, secret } = await editor();
    await as.post('/office/security/two-factor/confirm', { form: { code: twoFactorCode(secret), password: 'password' }, ...document }).assertOk().assertServerRendered();
    const response = await as
      .post('/office/security/two-factor/recovery-codes', { form: { password: 'password' }, ...document })
      .assertOk()
      .assertServerRendered();
    const markup = markupOf(response.body);
    expect(markup).toContain('<a href="/office/security" autofocus="">Done</a>');
    expect(layerOf(markup)).not.toContain('<button type="button"');
    expect(firstControlOf(layerOf(markup))).toBe('<a ');
  });
});
