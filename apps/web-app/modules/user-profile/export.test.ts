import { createTestApp, type TestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import type { User } from '../auth/users.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';

/** Signed in with a password just now — what the password confirmation ("sudo mode") asks for. */
async function signedIn(app: TestApp, user: User) {
  const login = await app.post('/login', { form: { email: user.email, password: 'password' } }).assertRedirect('/users/me');
  return app.withCookie('marmeon_session', login.cookie('marmeon_session')!);
}

describe('"Download my data" (a private disk and a signed, expiring URL)', () => {
  it('writes the export to the private disk and redirects to a signed download that works for five minutes', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    app.freeze();
    const ada = await app.factory(UserFactory).create({ name: 'Ada', email: 'ada@example.com' });
    await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Blog', url: 'https://ada.example' });
    const session = await signedIn(app, ada);

    const response = await session.post('/users/me/export').assertRedirect();
    const location = response.headers.get('location')!;
    expect(location).toMatch(new RegExp(`^/_marmeon/storage/local/exports/user-${ada.id}\\.json\\?filename=my-data-${ada.id}\\.json&expires=\\d+&signature=[0-9a-f]{64}$`));
    app.storage.disk('local').assertExists(`exports/user-${ada.id}.json`).assertCount(1);
    app.storage.disk('public').assertCount(0);

    const download = await app.get(location).assertOk(); // no session needed: the signature is the permission
    download.assertHeader('content-disposition', `attachment; filename="my-data-${ada.id}.json"; filename*=UTF-8''my-data-${ada.id}.json`);
    download.assertHeader('content-type', 'application/json').assertHeader('x-content-type-options', 'nosniff').assertHeader('content-security-policy', 'sandbox');
    download.assertHeader('cache-control', 'private, no-store');
    const data = JSON.parse(download.body) as { account: Record<string, unknown>; profile: { links: { label: string }[] } };
    expect(data.account).toMatchObject({ id: ada.id, name: 'Ada', email: 'ada@example.com' });
    expect(data.profile.links.map((link) => link.label)).toEqual(['Blog']);
    expect(download.body).not.toMatch(/password|\$argon2/); // never the hash

    app.travel({ minutes: 5, seconds: 1 });
    await app.get(location).assertForbidden(); // expired
  });

  it('the private file is never public — not under /storage, not with a tampered or foreign signature', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const location = (await (await signedIn(app, ada)).post('/users/me/export').assertRedirect()).headers.get('location')!;
    await (await signedIn(app, bob)).post('/users/me/export').assertRedirect();

    await app.get(`/storage/exports/user-${ada.id}.json`).assertNotFound();
    await app.get(`/storage/..%2fprivate%2fexports%2fuser-${ada.id}.json`).assertNotFound();
    await app.get(location.replace(`user-${ada.id}.json`, `user-${bob.id}.json`)).assertForbidden(); // Ada's signature, Bob's file
    await app.get(location.replace(/expires=\d+/, 'expires=9999999999')).assertForbidden();
    await app.get(location.replace(/&signature=.*/, '')).assertForbidden();
    await app.get(location).assertOk();
  });

  it('asks for the password first, like the security page — nothing is written before', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/users/me/export', { headers: { accept: 'text/html' } }).assertRedirect('/confirm-password');
    app.storage.disk('local').assertCount(0);
    await app.post('/users/me/export').assertRedirect('/login');
  });
});
