import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { PingWebhookLabController } from './controllers/WebhookPingLabController.ts';

/** `/lab/webhook-ping`: an address an editor enters is called by the server, and the client decides at send time. */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { env: { LAB_PAGES: 'true' } });
});
afterEach(async () => {
  await app.close();
});

const json = { accept: 'application/json' };

const FAILED = 'The address could not be pinged.';

describe('the webhook ping', () => {
  it('shows the form', async () => {
    await app.navigating().get('/lab/webhook-ping').assertOk().assertPage('lab/WebhookPing');
  });

  it('pings a public address with a JSON body and flashes the status', async () => {
    app.http.respond('https://hooks.example.com/in', new Response('ok', { status: 202 }));
    const sent = await app.post('/lab/webhook-ping', { form: { url: 'https://hooks.example.com/in' }, headers: { referer: 'http://localhost/lab/webhook-ping' } }).assertValid().assertRedirect('/lab/webhook-ping');
    await app
      .withCookie('marmeon_session', sent.cookie('marmeon_session')!)
      .navigating()
      .get('/lab/webhook-ping')
      .assertOk()
      .assertFlash('toast', { kind: 'success', message: 'The address answered 202.' });
    app.http.assertSentCount(1);
    const [request] = app.http.requests;
    expect([request!.method, await request!.clone().json()]).toEqual(['POST', { ping: true }]);
  });

  it.each(['http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://user:pass@hooks.example.com/'])('refuses %s at send time: the form is valid, the reply is never called', async (url) => {
    const reply = vi.fn(() => new Response('secret'));
    app.http.respond(/.*/, reply);
    const response = await app.post('/lab/webhook-ping', { json: { url }, headers: json }).assertUnprocessable();
    response.assertInvalid<PingWebhookLabController>({ url: FAILED });
    expect(reply).not.toHaveBeenCalled();
    app.http.assertNothingSent();
  });

  it('answers a refusal and a failed request the same, so the form tells a stranger nothing about the network', async () => {
    app.http.failNext('network');
    const failed = await app.post('/lab/webhook-ping', { json: { url: 'https://hooks.example.com/in' }, headers: json }).assertUnprocessable();
    failed.assertInvalid<PingWebhookLabController>({ url: FAILED });
    app.http.assertSentCount(1);
    await app.post('/lab/webhook-ping', { json: { url: 'not an address' }, headers: json }).assertUnprocessable();
    app.http.assertSentCount(1);
  });

  it('is a 404 unless the lab is on', async () => {
    await using off = await createTestApp(application, { env: { LAB_PAGES: 'false' } });
    await off.post('/lab/webhook-ping', { json: { url: 'https://hooks.example.com/in' }, headers: json }).assertNotFound();
    off.http.assertNothingSent();
  });
});
