import { UserFactory } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';

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
