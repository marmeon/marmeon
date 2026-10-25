import { Mailer, type Mailable } from '@marmeon/mail';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

class PingMail implements Mailable {
  envelope() {
    return { to: 'ada@example.com', subject: 'Ping' };
  }
  content() {
    return { html: '<p>Ping</p>', text: 'Ping' };
  }
}

describe('the app\'s own mail transport', () => {
  it('MAIL_DRIVER=scratch selects it; mailer.send() returns its message id', async () => {
    const app = await createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'scratch' } });
    const sent = await app.make(Mailer).send(new PingMail());
    expect(sent.messageId).toMatch(/^<.+@scratch\.test>$/);
    expect(sent.subject).toBe('Ping');
    await app.close();
  });

  it('stops the start for a MAIL_DRIVER nobody brought, naming the ones there are', async () => {
    await expect(createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'scrach' } })).rejects.toThrow(/Known: log, array, smtp, scratch\./);
  });
});
