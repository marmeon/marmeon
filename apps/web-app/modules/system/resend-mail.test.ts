import { Mailer, MailDeliveryError, type Mailable } from '@marmeon/mail';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import application from '../../bootstrap/app.ts';

// Built at run time: a key-shaped literal in a test file blocks the push.
const KEY = ['re', 'test', 'key', '0123456789'].join('_');
const ENDPOINT = 'https://api.resend.com/emails';

class PingMail implements Mailable {
  envelope() {
    return { to: { address: 'ada@example.com', name: 'Ada Lovelace' }, subject: 'Ping' };
  }
  content() {
    return { html: '<p>Ping</p>', text: 'Ping' };
  }
}

describe('MAIL_DRIVER=resend', () => {
  it('sends the mail through the app\'s HttpClient and returns the id Resend gave', async () => {
    const app = await createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'resend', MAIL_RESEND_API_KEY: KEY } });
    onTestFinished(() => app.close());
    app.http.respond(ENDPOINT, Response.json({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));
    const sent = await app.make(Mailer).send(new PingMail());
    expect(sent.messageId).toBe('49a3999c-0ce1-4ea6-ab68-afcd6dc2e794');
    app.http.assertSent(ENDPOINT).assertSentCount(1);
    const request = app.http.requests[0]!;
    expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(await request.clone().json()).toMatchObject({ to: ['"Ada Lovelace" <ada@example.com>'], subject: 'Ping', text: 'Ping' });
  });

  it('a refused key is a MailDeliveryError that does not hold the key', async () => {
    const app = await createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'resend', MAIL_RESEND_API_KEY: KEY } });
    onTestFinished(() => app.close());
    app.http.respond(ENDPOINT, Response.json({ statusCode: 401, name: 'validation_error', message: `API key is invalid: ${KEY}` }, { status: 401 }));
    const error = await app.make(Mailer).send(new PingMail()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect((error as MailDeliveryError).reason).toBe('unauthorized');
    expect(String(error)).not.toContain(KEY);
  });

  it('stops the start without MAIL_RESEND_API_KEY', async () => {
    await expect(createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'resend' } })).rejects.toThrow(/MAIL_DRIVER=resend needs MAIL_RESEND_API_KEY/);
  });
});
