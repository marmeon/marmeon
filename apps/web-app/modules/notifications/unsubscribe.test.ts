import { UrlSigner } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { AppConfig } from '../../config/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import { DigestMail } from './mail/DigestMail.ts';
import { DigestSender } from './DigestSender.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// With the CSRF check on: the point of the route is that it does without a token, a cookie and an Origin.
const boot = () => createTestApp(application, { csrf: true, database: 'refresh' });

const link = (app: TestApp, publicId: string) => DigestMail.unsubscribeUrl(app.make(UrlSigner), app.make(AppConfig), publicId);
const post = { form: { 'List-Unsubscribe': 'One-Click' } };

describe('leaving the digest mails with one click', () => {
  it('a mail carries both List-Unsubscribe headers; a post to the signed link in them, with no token, cookie or Origin, records the opt-out', async () => {
    const app = await boot();
    const ada = await app.factory(UserFactory).create({ name: 'Ada', locale: 'en' });
    expect(await app.make(DigestSender).send(ada)).toBe(true);
    const url = link(app, ada.public_id);
    app.mail.assertSent(DigestMail, (_mail, message) => message.headers['List-Unsubscribe'] === `<${url}>` && message.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');

    // What the mail client does: a POST with the body RFC 8058 names, to the link, and nothing else.
    await app.post(url, post).assertOk();
    await app.assertDatabaseHas('notification_opt_outs', { user_id: ada.id });
    // Twice changes nothing.
    await app.post(url, post).assertOk();
    await app.assertDatabaseCount('notification_opt_outs', 1);
  });

  it('an account that left gets no digest; another still does', async () => {
    const app = await boot();
    const ada = await app.factory(UserFactory).create({ name: 'Ada' });
    const bob = await app.factory(UserFactory).create({ name: 'Bob' });
    await app.post(link(app, ada.public_id), post).assertOk();
    const sender = app.make(DigestSender);
    expect(await sender.send(ada)).toBe(false);
    expect(await sender.send(bob)).toBe(true);
    expect(app.mail.sent(DigestMail)).toHaveLength(1);
  });

  it('the link in the text opens a page that leaves nothing; the form on it posts to the same address and leaves', async () => {
    const app = await boot();
    const ada = await app.factory(UserFactory).create({ name: 'Ada', email: 'ada@example.com' });
    const url = link(app, ada.public_id);
    const page = await app.get(url, { headers: { accept: 'application/json', [PAGE_HEADER]: PROTOCOL_VERSION } });
    page.assertOk();
    expect(page.headers.get('cache-control')).toBe('no-store, private');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    // The page object a view answers with; the address is masked, and the form posts to the address the page was opened at.
    const props = JSON.parse(page.body).props as { body: string; action: string };
    expect(props.body).toContain('a…@example.com');
    expect(props.body).not.toContain('ada@example.com');
    const action = props.action;
    expect(action).toBe(new URL(url).pathname + new URL(url).search);
    await app.assertDatabaseCount('notification_opt_outs', 0);

    await app.post(action!, { form: {} }).assertOk();
    await app.assertDatabaseHas('notification_opt_outs', { user_id: ada.id });
  });

  it('a request without a valid signature is refused: the post by the CSRF check, the page by the signature', async () => {
    const app = await boot();
    const ada = await app.factory(UserFactory).create({ name: 'Ada' });
    const bob = await app.factory(UserFactory).create({ name: 'Bob' });
    await app.post(`/notifications/unsubscribe/${ada.public_id}`, post).assertStatus(419);
    await app.get(`/notifications/unsubscribe/${ada.public_id}`, { headers: { accept: 'text/html' } }).assertStatus(403);
    // Bob's signature on Ada's address.
    await app.post(`/notifications/unsubscribe/${ada.public_id}?${link(app, bob.public_id).split('?')[1]}`, post).assertStatus(419);
    await app.assertDatabaseCount('notification_opt_outs', 0);
  });

  it('a signed link to an account that does not exist is a 404', async () => {
    const app = await boot();
    await app.post(link(app, '0190a000-0000-7000-8000-00000000ffff'), post).assertStatus(404);
  });
});
