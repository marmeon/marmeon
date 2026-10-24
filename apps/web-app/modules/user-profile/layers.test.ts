import { UserRepository, type User } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ConfirmRemoveLinkController } from './controllers/ConfirmRemoveLinkController.ts';
import type { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

const profile = (user: User) => `/users/${user.public_id}`;

describe('editing a profile is a layer', () => {
  it('opens as a layer: its page object says so — the base for deep links is the profile', async () => {
    const response = await app.actingAs(ada).layer('user-profile.edit', { user: ada.public_id }).assertOk();
    response.assertLayer<EditUserProfileController>('user-profile/Edit', { profile: { name: 'Ada Lovelace' } });
    expect(response.page()!.layer).toEqual({ key: 'user-profile/Edit', base: profile(ada) });
  });

  it('the layer’s own authorization holds — someone else’s edit layer is a 403, wherever it opens', async () => {
    await app.actingAs(alan).layer('user-profile.edit', { user: ada.public_id }).assertForbidden();
    await app.actingAs(alan).get(`${profile(ada)}/edit`, { headers: { accept: 'text/html' } }).assertForbidden();
  });

  it('a deep link (or a reload) of the layer’s URL: the profile under it, in one document', async () => {
    const response = await app.actingAs(ada).get(`${profile(ada)}/edit`, { headers: { accept: 'text/html' } }).assertOk();
    response.assertPage('user-profile/Show', { profile: { name: 'Ada Lovelace' } });
    expect(response.layers().map((layer) => [layer.component, layer.url])).toEqual([['user-profile/Edit', `${profile(ada)}/edit`]]);
  });

  it('a deep link to “remove this link?” stacks three: the profile, the edit layer, the confirmation', async () => {
    const link = await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Blog' });
    const response = await app.actingAs(ada).get(`${profile(ada)}/links/${link.id}/remove`, { headers: { accept: 'text/html' } }).assertOk();
    response.assertPage('user-profile/Show');
    expect(response.layers().map((layer) => layer.component)).toEqual(['user-profile/Edit', 'user-profile/RemoveLink']);
    await app.actingAs(ada).layer('user-profile.links.remove', { user: ada.public_id, link: link.id }).assertLayer<ConfirmRemoveLinkController>('user-profile/RemoveLink', { link: { label: 'Blog' } });
  });

  it('saving closes the layer and reloads the profile and the message beneath — no layer, no JavaScript: to the profile', async () => {
    await app
      .actingAs(ada)
      .layering()
      .put(profile(ada), { json: { name: 'Ada King', bio: 'Countess' } })
      .assertLayerClosed({ reload: ['profile'] })
      // The close is shown: it delivers the message itself — nothing waits in the session for the reload.
      .assertFlash('toast', { kind: 'success', message: 'Profile saved.' });
    await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada King' });
    await app.actingAs(ada).put(profile(ada), { form: { name: 'Ada', bio: '' } }).assertRedirect(profile(ada));
  });

  it('a failed save stays in the layer: back to the layer’s URL — whose answer, as the layer, carries the errors', async () => {
    const session = app.actingAs(ada).layering();
    const failed = await session
      .put(profile(ada), { json: { name: 'A', bio: '' }, headers: { referer: `http://localhost${profile(ada)}/edit` } })
      .assertRedirect(`${profile(ada)}/edit`);
    const cookie = failed.cookie('marmeon_session');
    await app
      .actingAs(ada)
      .withCookie('marmeon_session', cookie!)
      .layering()
      .get(`${profile(ada)}/edit`)
      .assertLayer('user-profile/Edit', { errors: { name: ['The name needs at least 2 characters.'] } });
  });

  it('removing a link from its confirmation closes it — what is beneath (the profile, or the edit layer) reloads its `profile`', async () => {
    const link = await app.factory(ProfileLinkFactory).create({ user_id: ada.id });
    await app.actingAs(ada).layering().delete(`${profile(ada)}/links/${link.id}`).assertLayerClosed({ reload: ['profile'] });
    await app.assertDatabaseMissing('profile_links', { id: link.id });
    await app.actingAs(alan).layer('user-profile.links.remove', { user: ada.public_id, link: link.id }).assertNotFound();
  });
});

describe('creating an API token is a layer shown once', () => {
  it('a deep link of the form: the list under it — and reloading after creating shows the list, never the plain text', async () => {
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } });
    const session = app.withCookie('marmeon_session', login.cookie('marmeon_session')!);
    const form = await session.get('/settings/tokens/create', { headers: { accept: 'text/html' } }).assertOk();
    form.assertPage('auth/AccessTokens');
    expect(form.layers().map((layer) => layer.component)).toEqual(['auth/CreateAccessToken']);

    const created = await session.layering().post('/settings/tokens', { json: { current_password: 'password', name: 'CLI', abilities: ['users:read'] } }).assertLayer('auth/NewAccessToken');
    const plainText = (created.page()!.props as { plainText: string }).plainText;
    // Its URL asked again (a reload, Forward after it was forgotten) is the list — the plain text is gone for good.
    const again = await session.navigating().get(created.page()!.url).assertPage('auth/AccessTokens');
    expect(again.body).not.toContain(plainText);
  });
});
