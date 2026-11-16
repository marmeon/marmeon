import { UserFactory } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { SearchProfileLinksController } from './controllers/SearchProfileLinksController.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';
import { ProfileLinkRepository } from './ProfileLinkRepository.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const verified = () => app.factory(UserFactory).create({ email_verified_at: new Date() });

describe('renaming a link with a form — a stale save goes back to the form', () => {
  it('two saves from the same stale version: the second goes back with the conflict, and the label is the first one’s', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const seen = new Date(notes.updated_at).toISOString();
    const links = `/users/${ada.public_id}/links`;
    const save = (label: string) => app.actingAs(ada).put(`${links}/${notes.id}`, { form: { label, seen }, headers: { accept: 'text/html', referer: `http://localhost${links}` } });
    // The page a visit gets after a save, with the session cookie of that save.
    const visit = (saved: Awaited<ReturnType<typeof save>>) => app.withCookie('marmeon_session', saved.cookie('marmeon_session')!).navigating();

    const first = await save('First').assertRedirect(links);
    const clean = (await visit(first).get(links).assertOk()).page()!;
    expect(clean.props._conflict).toBeNull();
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'First' });
    // The page carries the version the save made: newer than the one the form had.
    const saved = (clean.props.links as { version: string }[])[0]!.version;
    expect(Date.parse(saved)).toBeGreaterThan(Date.parse(seen));

    const second = await save('Second').assertRedirect(links);
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'First' });
    const next = visit(second);
    const page = (await next.get(links).assertPage<SearchProfileLinksController>('user-profile/Links').assertOk()).page()!;
    expect(page.props._conflict).toEqual({ message: 'Someone else changed this in the meantime.', current: { label: 'First', savedAt: expect.any(String) } });
    expect((page.props.links as { label: string }[])[0]).toMatchObject({ label: 'First' });
    // Shown once: the visit after it has none.
    expect((await next.get(links).assertOk()).page()!.props._conflict).toBeNull();
    // “Keep mine”: the typed label again, with the version the conflict named — it passes, once.
    const current = (page.props._conflict as { current: { savedAt: string } }).current;
    expect(current.savedAt).toBe(saved);
    await app.actingAs(ada).put(`${links}/${notes.id}`, { form: { label: 'Third', seen: current.savedAt }, headers: { accept: 'text/html', referer: `http://localhost${links}` } }).assertRedirect(links);
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'Third' });
  });

  it('a stale value that is no timestamp is a validation error — not a conflict', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const links = `/users/${ada.public_id}/links`;
    const saved = await app.actingAs(ada).put(`${links}/${notes.id}`, { form: { label: 'Mine', seen: 'yesterday' }, headers: { referer: `http://localhost${links}` } }).assertRedirect(links);
    const page = (await app.withCookie('marmeon_session', saved.cookie('marmeon_session')!).navigating().get(links).assertOk()).page()!;
    expect(page.props).toMatchObject({ errors: { seen: expect.anything() } });
    expect(page.props._conflict).toBeNull();
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'Notes' });
  });

  it('a link that is gone is a 404 — there is nothing to compare', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const seen = new Date(notes.updated_at).toISOString();
    await app.make(ProfileLinkRepository).delete(notes.id);
    await app.actingAs(ada).put(`/users/${ada.public_id}/links/${notes.id}`, { form: { label: 'Mine', seen } }).assertNotFound();
  });

  it('offers the rename only to the profile’s owner: the page’s abilities', async () => {
    const ada = await verified();
    const alan = await verified();
    const links = `/users/${ada.public_id}/links`;
    await app.actingAs(ada).navigating().get(links).assertPage<SearchProfileLinksController>('user-profile/Links', { abilities: { update: true } });
    await app.actingAs(alan).navigating().get(links).assertPage<SearchProfileLinksController>('user-profile/Links', { abilities: { update: false } });
  });

  it('a link that is gone between the lookup and the save goes back as a conflict without a record', async () => {
    await app.close();
    class Gone extends ProfileLinkRepository {
      override renameIfCurrent() {
        return Promise.resolve(undefined);
      }
    }
    const gone = await createTestApp(application, { database: 'refresh', override: (c) => c.singleton(ProfileLinkRepository, Gone) });
    const ada = await gone.factory(UserFactory).create({ email_verified_at: new Date() });
    const notes = (await gone.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const links = `/users/${ada.public_id}/links`;
    const saved = await gone.actingAs(ada).put(`${links}/${notes.id}`, { form: { label: 'Mine', seen: new Date(notes.updated_at).toISOString() }, headers: { accept: 'text/html', referer: `http://localhost${links}` } }).assertRedirect(links);
    const page = (await gone.withCookie('marmeon_session', saved.cookie('marmeon_session')!).navigating().get(links).assertOk()).page()!;
    expect(page.props._conflict).toEqual({ message: 'Someone else changed this in the meantime.' });
    await gone.close();
  });
});

const VERIFY = '/email/verify';

describe('PUT /users/:user/links/:link — who may call it', () => {
  const put = (as: TestApp, user: { public_id: string }, link: { id: string; updated_at: string }) =>
    as.put(`/users/${user.public_id}/links/${link.id}`, { form: { label: 'Mine', seen: new Date(link.updated_at).toISOString() }, headers: { accept: 'text/html' } });

  it('refuses a guest, an unverified address and someone else’s profile — and a link of another user under your own', async () => {
    const ada = await verified();
    const alan = await verified();
    const unverified = await app.factory(UserFactory).create({ email_verified_at: null });
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const theirs = (await app.factory(ProfileLinkFactory).create({ user_id: alan.id, label: 'Theirs' }))!;
    const own = (await app.factory(ProfileLinkFactory).create({ user_id: unverified.id, label: 'Own' }))!;
    await put(app, ada, notes).assertRedirect('/login');
    // A page request of an unverified address is sent to the verification notice, never to the controller.
    await put(app.actingAs(unverified), unverified, own).assertStatus(302).assertHeader('location', VERIFY);
    await put(app.actingAs(alan), ada, notes).assertForbidden();
    await put(app.actingAs(ada), ada, theirs).assertNotFound();
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'Notes' });
    await app.assertDatabaseHas('profile_links', { id: theirs.id, label: 'Theirs' });
    await app.assertDatabaseHas('profile_links', { id: own.id, label: 'Own' });
  });
});
