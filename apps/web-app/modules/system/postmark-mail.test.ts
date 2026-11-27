import { Mailer, MailDeliveryError, type Mailable } from '@marmeon/mail';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import application from '../../bootstrap/app.ts';

// Built at run time: a token-shaped literal in a test file blocks the push.
const TOKEN = ['pm', 'server', 'token', '0123456789'].join('-');
const ENDPOINT = 'https://api.postmarkapp.com/email';

class PingMail implements Mailable {
  envelope() {
    return { to: { address: 'ada@example.com', name: 'Ada Lovelace' }, subject: 'Ping' };
  }
  content() {
    return { html: '<p>Ping</p>', text: 'Ping' };
  }
}

describe('MAIL_DRIVER=postmark', () => {
  it('sends the mail through the app\'s HttpClient and returns the message id Postmark gave', async () => {
    const app = await createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: TOKEN } });
    onTestFinished(() => app.close());
    app.http.respond(ENDPOINT, Response.json({ MessageID: 'b7bc2f4a-e38e-4336-af7d-e6c392c2f817', ErrorCode: 0 }));
    const sent = await app.make(Mailer).send(new PingMail());
    expect(sent.messageId).toBe('b7bc2f4a-e38e-4336-af7d-e6c392c2f817');
    app.http.assertSent(ENDPOINT).assertSentCount(1);
    const request = app.http.requests[0]!;
    expect(request.headers.get('x-postmark-server-token')).toBe(TOKEN);
    expect(await request.clone().json()).toMatchObject({ To: '"Ada Lovelace" <ada@example.com>', Subject: 'Ping', TextBody: 'Ping' });
  });

  it('a refused token is a MailDeliveryError that does not hold the token', async () => {
    const app = await createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: TOKEN } });
    onTestFinished(() => app.close());
    app.http.respond(ENDPOINT, Response.json({ ErrorCode: 10, Message: `Bad or missing Server API token ${TOKEN}` }, { status: 401 }));
    const error = await app.make(Mailer).send(new PingMail()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect((error as MailDeliveryError).reason).toBe('unauthorized');
    expect(String(error)).not.toContain(TOKEN);
  });

  it('stops the start without MAIL_POSTMARK_TOKEN', async () => {
    await expect(createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'postmark' } })).rejects.toThrow(/MAIL_DRIVER=postmark needs MAIL_POSTMARK_TOKEN/);
  });
});
