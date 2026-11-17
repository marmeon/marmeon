import { UserFactory } from '#modules/auth';
import { Connections, sql } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';
import { ProfileLinkRepository } from './ProfileLinkRepository.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const verified = () => app.factory(UserFactory).create({ email_verified_at: new Date() });

describe('profile links as actions — what useAction sends and gets back', () => {
  it('adds a link: the redirect is reported, not followed — the action delivers its flash message itself', async () => {
    const ada = await verified();
    const session = app.actingAs(ada);
    await session
      .acting()
      .post(`/users/${ada.public_id}/links`, { json: { label: 'Blog', url: 'https://blog.example' } })
      .assertActionRedirect(`/users/${ada.public_id}`)
      .assertHeader('cache-control', 'no-store')
      // With the answer (`x-marmeon-flash`): `useAction` fires it once — no reload of a `flash` prop needed.
      .assertFlash('toast', { kind: 'success', message: 'Link added.' });
    await app.assertDatabaseHas('profile_links', { user_id: ada.id, label: 'Blog' });
    // The action's `reload: router.reloading({ only: ['profile'] })` — the new link, nothing else computed.
    const page = (await session.reloading<ShowUserProfileController>('user-profile/Show', { only: ['profile'] }).get(`/users/${ada.public_id}`).assertOk()).page()!;
    expect(Object.keys(page.props).sort()).toEqual(['errors', 'profile']);
    // …and the reload does not deliver it again: the action took it.
    expect(page.flash).toBeUndefined();
    expect((page.props.profile as { links: { label: string }[] }).links.map((link) => link.label)).toEqual(['Blog']);
  });

  it('invalid input is a 422 with the errors by field — nothing stored, no redirect back to the form', async () => {
    const ada = await verified();
    const response = await app.actingAs(ada).acting().post(`/users/${ada.public_id}/links`, { json: { label: '', url: 'javascript:alert(1)' } }).assertStatus(422);
    expect(Object.keys(response.json<{ errors: Record<string, string[]> }>().errors).sort()).toEqual(['label', 'url']);
    await app.assertDatabaseCount('profile_links', 0);
  });

  it('an unverified address (403), someone else’s profile (403), someone else’s link (404) — answers, never redirects', async () => {
    const unverified = await app.factory(UserFactory).create({ email_verified_at: null });
    await app.actingAs(unverified).acting().post(`/users/${unverified.public_id}/links`, { json: { label: 'x', url: 'https://x.example' } }).assertForbidden();
    const ada = await verified();
    const alan = await verified();
    await app.actingAs(alan).acting().post(`/users/${ada.public_id}/links`, { json: { label: 'x', url: 'https://x.example' } }).assertForbidden();
    const theirs = (await app.factory(ProfileLinkFactory).create({ user_id: alan.id, label: 'Theirs' }))!;
    await app.actingAs(ada).acting().delete(`/users/${ada.public_id}/links/${theirs.id}`).assertNotFound();
    await app.assertDatabaseHas('profile_links', { id: theirs.id });
  });

  it('removes a link: reported as the redirect closeLayer() is without a layer — the same controller as the confirmation layer’s', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    await app.actingAs(ada).acting().delete(`/users/${ada.public_id}/links/${notes.id}`).assertActionRedirect(`/users/${ada.public_id}`);
    await app.assertDatabaseMissing('profile_links', { id: notes.id });
  });

  it('renames a link when the page has its latest version, and answers the new one', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const saved = await app.actingAs(ada).acting().patch(`/users/${ada.public_id}/links/${notes.id}`, { json: { label: 'Blog', seen: new Date(notes.updated_at).toISOString() } }).assertOk();
    expect(saved.json<{ label: string }>().label).toBe('Blog');
    // The answered version is newer than the one the page sent: the next save of the old version is stale.
    expect(Date.parse(saved.json<{ updated_at: string }>().updated_at)).toBeGreaterThan(Date.parse(new Date(notes.updated_at).toISOString()));
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'Blog' });
  });

  it('answers a stale rename with a conflict: 409, the header, the link as it is now — and saves nothing', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const seen = new Date(notes.updated_at).toISOString();
    const later = new Date(Date.parse(seen) + 5000).toISOString();
    await app.make(ProfileLinkRepository).update(notes.id, { label: 'Theirs', updated_at: later });
    const response = await app.actingAs(ada).acting().patch(`/users/${ada.public_id}/links/${notes.id}`, { json: { label: 'Mine', seen } }).assertStatus(409).assertHeader('x-marmeon-conflict', '1');
    expect(response.json<{ current: unknown }>().current).toEqual({ label: 'Theirs', savedAt: later });
    expect(response.headers.get('x-marmeon-location')).toBeNull();
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'Theirs' });
  });

  it('compares versions at the precision the client sees: a link stamped with microseconds (a column default) saves fresh and conflicts when stale', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    // What a write outside the repository leaves: PostgreSQL keeps the microseconds, a JavaScript date and its ISO string cannot.
    await app.make(Connections).get().updateTable('profile_links').set({ updated_at: sql`'2026-03-01 10:00:00.123456'` as never }).where('id', '=', notes.id).execute();
    const seen = (await app.make(ProfileLinkRepository).find(notes.id))!.updated_at;
    await app.actingAs(ada).acting().patch(`/users/${ada.public_id}/links/${notes.id}`, { json: { label: 'Mine', seen: new Date(seen).toISOString() } }).assertOk();
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'Mine' });
    // The same version again is stale now: the first save moved it.
    await app.actingAs(ada).acting().patch(`/users/${ada.public_id}/links/${notes.id}`, { json: { label: 'Again', seen: new Date(seen).toISOString() } }).assertStatus(409);
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'Mine' });
  });

  it('two saves of the same version cannot both pass, not even in the millisecond the link was stamped in', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const seen = new Date(app.freeze()).toISOString();
    await app.make(ProfileLinkRepository).update(notes.id, { updated_at: seen });
    await app.actingAs(ada).acting().patch(`/users/${ada.public_id}/links/${notes.id}`, { json: { label: 'First', seen } }).assertOk();
    await app.actingAs(ada).acting().patch(`/users/${ada.public_id}/links/${notes.id}`, { json: { label: 'Second', seen } }).assertStatus(409);
    await app.assertDatabaseHas('profile_links', { id: notes.id, label: 'First' });
  });

  it('two saves at once with the same version: one passes, the other conflicts', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    const seen = new Date(notes.updated_at).toISOString();
    const save = (label: string) => app.actingAs(ada).acting().patch(`/users/${ada.public_id}/links/${notes.id}`, { json: { label, seen } });
    const statuses = (await Promise.all([save('One'), save('Two')])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('answers 403 or 404 before any version is compared: someone else’s profile, someone else’s link', async () => {
    const ada = await verified();
    const alan = await verified();
    const theirs = (await app.factory(ProfileLinkFactory).create({ user_id: alan.id, label: 'Theirs' }))!;
    const stale = { label: 'Mine', seen: '2020-01-01T00:00:00.000Z' };
    await app.actingAs(ada).acting().patch(`/users/${ada.public_id}/links/${theirs.id}`, { json: stale }).assertNotFound();
    await app.actingAs(ada).acting().patch(`/users/${alan.public_id}/links/${theirs.id}`, { json: stale }).assertForbidden();
    await app.assertDatabaseHas('profile_links', { id: theirs.id, label: 'Theirs' });
  });

  it('signed out: 401 as JSON — the browser shows it, nothing follows a redirect to the login page', async () => {
    const ada = await verified();
    const notes = (await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }))!;
    await app.acting().delete(`/users/${ada.public_id}/links/${notes.id}`).assertUnauthorized();
    await app.assertDatabaseHas('profile_links', { id: notes.id });
  });

  it('with CSRF on: an action without the token is a 419 — never applied', async () => {
    await app.close();
    const csrf = await createTestApp(application, { database: 'refresh', csrf: true });
    try {
      const ada = await csrf.factory(UserFactory).create({ email_verified_at: new Date() });
      await csrf.actingAs(ada).acting().post(`/users/${ada.public_id}/links`, { json: { label: 'Blog', url: 'https://blog.example' } }).assertStatus(419);
      await csrf.assertDatabaseCount('profile_links', 0);
    } finally {
      await csrf.close();
    }
  });
});
