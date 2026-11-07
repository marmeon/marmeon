import { Translators } from '@marmeon/i18n';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../../bootstrap/app.ts';
import { DigestMail } from './DigestMail.ts';

const URL = 'https://app.test/notifications/unsubscribe/ada?signature=abc&expires=1';

describe('DigestMail', () => {
  it('renders its React view to a mail: the intro, the items and the link that leaves the list', async () => {
    const app = await createTestApp(application);
    const t = app.make(Translators).for('en');
    await app.mail.send(new DigestMail('ada@example.com', URL, t, ['New sign-in', 'A note was shared']));
    const { message } = app.mail.sent(DigestMail)[0]!;
    expect(message.html).toContain('You have new notifications.');
    expect(message.html).toContain('A note was shared');
    expect(message.html).toContain(`<a href="${URL.replace('&', '&amp;')}">Stop these mails</a>`);
    expect(message.text).toContain(`Stop these mails (${URL})`);
  });

  it('writes a title that holds markup as text, so it cannot add an element or an image', async () => {
    const app = await createTestApp(application);
    await app.mail.send(new DigestMail('ada@example.com', URL, app.make(Translators).for('en'), ['<img src="https://tracker.test/p.gif"> & "more"']));
    const { message } = app.mail.sent(DigestMail)[0]!;
    expect(message.html).toContain('&lt;img src=&quot;https://tracker.test/p.gif&quot;&gt; &amp; &quot;more&quot;');
    expect(message.html).not.toContain('<img');
  });
});
