import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { fromHtml, html, MailServiceProvider, MailTransport, type Mailable } from '@marmeon/mail';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';

class WelcomeMail implements Mailable {
  envelope() {
    return { to: 'ada@example.com', subject: 'Welcome' };
  }
  content() {
    return fromHtml(html`<p>Welcome</p>`);
  }
}

const definition: ApplicationDefinition = {
  root: tempDir('marmeon-testing-mail-'),
  discover: false,
  providers: [EncryptionServiceProvider, MailServiceProvider],
  modules: [defineModule({ name: 'mail-fake' })],
};

const env = { APP_KEY: generateKey(), MAIL_FROM: 'team@example.com' };

describe('app.mail', () => {
  it('returns a message id and fails the next send after failNext()', async () => {
    await using app = await createTestApp(definition, { env });
    const sent = await app.mail.send(new WelcomeMail());
    expect(sent.messageId).toMatch(/^<fake-\d+@marmeon\.test>$/);
    app.mail.failNext();
    await expect(app.mail.send(new WelcomeMail())).rejects.toThrow('The fake mailer failed this send.');
    await expect(app.mail.send(new WelcomeMail())).resolves.toBeDefined();
    app.mail.assertSentCount(WelcomeMail, 2);
  });

  it('leaves a MailTransport the app binds itself alone', async () => {
    const own: MailTransport = { send: async () => ({ messageId: undefined }) };
    await using app = await createTestApp(definition, { env, override: (c) => c.instance(MailTransport, own) });
    expect(app.make(MailTransport)).toBe(own);
  });
});
