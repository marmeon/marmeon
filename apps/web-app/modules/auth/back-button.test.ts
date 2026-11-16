import { NO_STORE } from '@marmeon/auth';
import { LOCATION_HEADER, PAGE_HEADER, type PageObject } from '@marmeon/http/protocol';
import { createHttpKernel } from '@marmeon/server';
import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { FakeTab, ORIGIN } from './fake-tab.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from './warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
let REMEMBER: string;
let tab: FakeTab;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
  ({ remember: REMEMBER } = cookieNames(app));
  tab = new FakeTab(createHttpKernel(app.application), { bfcache: true });
});

/** Signs in, creates an API token (its plain text is shown once) and signs out — the attack's setup. */
async function createTokenThenSignOut() {
  const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
  await tab.open('/login');
  await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
  expect(tab.visible.component).toBe('user-profile/Show');
  await tab.visit('/settings/tokens');
  // The form is a layer over the list; its answer — the plain text — replaces it, shown once.
  await tab.visit('/settings/tokens/create', { layer: true });
  await tab.layerVisit('/settings/tokens', { method: 'post', data: { current_password: 'password', name: 'Backup script', abilities: ['users:read'] } });
  expect(tab.layers.map((layer) => layer.component)).toEqual(['auth/NewAccessToken']);
  const plainText = tab.layers[0]!.props.plainText as string;
  expect(plainText).toMatch(/^marmeon_[A-Za-z0-9]{48}$/);
  await tab.visit('/logout', { method: 'post' });
  expect(tab.visible.component).toBe('auth/Login');
  return { ada, plainText };
}

/** Everything a page (and the layers over it) shows that would give the signed-out user away. */
const leaks = (page: PageObject, plainText: string) => {
  const shown = JSON.stringify([page, tab.layers]);
  return [plainText, 'ada@example.com', 'Ada Lovelace'].filter((secret) => shown.includes(secret));
};

describe('Back after signing out', () => {
  it.each([
    ['with the back/forward cache', true],
    ['without it — Back takes documents from the HTTP cache', false],
  ])('the attack (%s): Back after signing out shows neither the token nor the profile — the login page', async (_, bfcache) => {
    tab = new FakeTab(createHttpKernel(app.application), { bfcache });
    const { plainText } = await createTokenThenSignOut();
    // Back through every entry: the token layer's (the plain text), the list, the profile, /login.
    while (tab.index > 0) {
      await tab.back();
      expect(leaks(tab.visible, plainText), `Back to ${tab.entries[tab.index]!.url} shows ${tab.visible.component}`).toEqual([]);
      expect(tab.visible.component).toBe('auth/Login');
    }
  });

  it.each([
    ['with the back/forward cache', true],
    ['without it — Back takes documents from the HTTP cache', false],
  ])('full page loads (%s): Back to a page loaded fully before signing out asks the server again', async (_, bfcache) => {
    tab = new FakeTab(createHttpKernel(app.application), { bfcache });
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    await tab.open('/settings/security'); // typed into the address bar: each one its own document
    expect(tab.visible.props).toMatchObject({ email: 'ada@example.com' });
    await tab.open('/users/me');
    await tab.visit('/logout', { method: 'post' });

    const asked = tab.requests.length;
    while (tab.index > 0) {
      await tab.back();
      expect(leaks(tab.visible, 'no token here'), `Back to ${tab.entries[tab.index]!.url} shows ${tab.visible.component}`).toEqual([]);
    }
    // Every protected document was requested again (and redirected to the login page), none came from a cache.
    expect(tab.requests.slice(asked)).toEqual(expect.arrayContaining([`GET /users/${ada.public_id}`, 'GET /settings/security']));
  });

  it('a page prefetched while signed in is gone with the sign-out — neither Back nor a visit shows it', async () => {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    await tab.visit('/settings/security'); // a fresh sign-in counts as a confirmed password: the page itself
    await tab.visit(`/users/${ada.public_id}`);
    await tab.prefetch('/settings/security'); // hovered, never clicked
    expect(tab.requests.at(-1)).toBe('GET /settings/security (visit)');
    await tab.visit('/logout', { method: 'post' });
    expect(tab.visible.component).toBe('auth/Login');

    const asked = tab.requests.length;
    await tab.visit('/settings/security');
    expect(leaks(tab.visible, 'no token here')).toEqual([]);
    expect(tab.visible.component).toBe('auth/Login');
    expect(tab.requests.slice(asked)).toEqual(['GET /settings/security (visit)', 'GET /login (visit)']); // the server was asked
    while (tab.index > 0) {
      await tab.back();
      expect(leaks(tab.visible, 'no token here'), `Back to ${tab.entries[tab.index]!.url}`).toEqual([]);
    }
  });

  it('keeps no props in history.state — nothing of the token or the profile is written to disk', async () => {
    const { plainText } = await createTokenThenSignOut();
    expect(tab.entries.length).toBeGreaterThan(2);
    for (const { state } of tab.entries) {
      expect(state).not.toContain(plainText);
      expect(state).not.toContain('ada@example.com');
      // A layer's entry adds its depth and the keys beneath it — never what it shows.
      // `index`: the entry's position (the navigation guard) — a number.
      if (state !== 'null') expect(Object.keys(JSON.parse(state)).filter((key) => key !== 'layer').sort()).toEqual(['component', 'index', 'key', 'scroll', 'url']);
    }
  });

  it('signs in and out with a full page load: the server answers the visit with 409 + x-marmeon-location', async () => {
    const { ada } = await createTokenThenSignOut();
    // The 303s of login and logout never reach the client as page JSON: each is followed by a document load.
    expect(tab.requests).toEqual([
      'GET /login',
      'POST /login (visit)', // → 409, x-marmeon-location: /users/me
      'GET /users/me',
      `GET /users/${ada.public_id}`,
      `GET /users/${ada.public_id} (visit)`, // the profile's deferred activity, loaded after the page (a partial reload)
      'GET /settings/tokens (visit)',
      'GET /settings/tokens/create (visit)', // the form: a layer
      'POST /settings/tokens (visit)', // its answer: the plain text, a layer shown once
      'POST /logout (visit)', // → 409, x-marmeon-location: /login, Clear-Site-Data: "storage"
      'GET /login',
    ]);
  });

  it('never stores what a signed-in user saw: no document of theirs is in the HTTP cache', async () => {
    await createTokenThenSignOut();
    expect([...tab.httpCache.keys()]).toEqual([`${ORIGIN}/login`]);
  });
});

describe('Cache headers', () => {
  it('marks every answer for a signed-in user no-store, private — pages, page JSON, redirects, error pages', async () => {
    const ada = await app.factory(UserFactory).create();
    const signedIn = app.actingAs(ada);
    await signedIn.get(`/users/${ada.public_id}`).assertOk().assertHeader('cache-control', NO_STORE);
    await signedIn.navigating().get(`/users/${ada.public_id}`).assertOk().assertHeader('cache-control', NO_STORE);
    await signedIn.get('/users/me').assertRedirect().assertHeader('cache-control', NO_STORE);
    await signedIn.get('/users/999999').assertNotFound().assertHeader('cache-control', NO_STORE);
  });

  it('leaves guests’ answers alone', async () => {
    const response = await app.get('/login').assertOk();
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('varies pages on x-marmeon (and the partial-reload and prefetch headers, and the language): the HTML document and the page JSON of one URL are two cache entries', async () => {
    const html = await app.get('/login').assertOk();
    const json = await app.navigating().get('/login').assertOk();
    for (const response of [html, json]) {
      expect(response.headers.get('vary')?.split(', ')).toEqual([PAGE_HEADER, 'x-marmeon-region', 'x-marmeon-partial-component', 'x-marmeon-partial-data', 'x-marmeon-partial-except', 'purpose', 'x-marmeon-once', 'x-marmeon-once-scope', 'accept-language']);
    }
  });

  it('answers a sign-out visit with a full page load and Clear-Site-Data; a plain form post keeps its 303', async () => {
    const ada = await app.factory(UserFactory).create();
    const visit = await app.actingAs(ada).navigating().post('/logout').assertStatus(409).assertGuest();
    expect(visit.headers.get(LOCATION_HEADER)).toBe('/login');
    expect(visit.headers.get('clear-site-data')).toBe('"storage"');
    expect(visit.headers.get('location')).toBeNull();

    const form = await app.actingAs(ada).post('/logout').assertStatus(303).assertRedirect('/login');
    expect(form.headers.get('clear-site-data')).toBe('"storage"');
  });

  it('answers a sign-in visit with a full page load to where the login was headed', async () => {
    const ada = await app.factory(UserFactory).create();
    const visit = await app.navigating().post('/login', { json: { email: ada.email, password: 'password' } }).assertStatus(409).assertAuthenticated(ada);
    expect(visit.headers.get(LOCATION_HEADER)).toBe('/users/me');
    expect(visit.headers.get('clear-site-data')).toBeNull(); // only signing out clears the storage

    // A failed login changes nobody: an ordinary visit answer (back to the form, with errors).
    await app.navigating().post('/login', { json: { email: ada.email, password: 'wrong' } }).assertStatus(303);
  });

  it('does not reload for a "keep me signed in" sign-in — the same person continues', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', { form: { email: ada.email, password: 'password', remember: 'on' } });
    // A new browser session (no session cookie), the remember-me cookie signs in during an ordinary visit.
    await app.withCookie(REMEMBER, login.cookie(REMEMBER)!).navigating().get(`/users/${ada.public_id}`).assertOk().assertAuthenticated(ada);
  });
});

describe('Layers in a tab — the real app, the real navigator', () => {
  /** Signed in on Ada's profile, its deferred activity loaded. */
  async function onProfile() {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    expect(tab.visible.component).toBe('user-profile/Show');
    return ada;
  }

  it('Back closes the layer, not the page — no request, the profile’s deferred props not asked again; Forward opens it from memory', async () => {
    const ada = await onProfile();
    const entries = tab.entries.length;
    const asked = tab.requests.length;
    await tab.visit(`/users/${ada.public_id}/edit`, { layer: true });
    expect(tab.layers.map((layer) => layer.component)).toEqual(['user-profile/Edit']);
    expect(tab.entries.length).toBe(entries + 1);
    expect(tab.visible.component).toBe('user-profile/Show');

    await tab.back();
    expect(tab.layers).toEqual([]);
    expect(tab.visible.component).toBe('user-profile/Show');
    await tab.forward();
    expect(tab.layers.map((layer) => layer.component)).toEqual(['user-profile/Edit']);
    // One request in all — the layer's. Not the profile again, not its deferred activity.
    expect(tab.requests.slice(asked)).toEqual([`GET /users/${ada.public_id}/edit (visit)`]);
    for (const { state } of tab.entries) expect(state).not.toContain('ada@example.com');
  });

  it('a reload on the layer’s URL shows the declared base and the layer — from one document', async () => {
    const ada = await onProfile();
    await tab.visit('/people');
    await tab.visit(`/users/${ada.public_id}/edit`, { layer: true });
    expect(tab.visible.component).toBe('user-profile/People'); // opened over the page on screen

    const asked = tab.requests.length;
    await tab.reload();
    // One document (then the base's deferred activity, as after any full load of the profile).
    expect(tab.requests.slice(asked)).toEqual([`GET /users/${ada.public_id}/edit`, `GET /users/${ada.public_id} (visit)`]);
    expect(tab.visible.component).toBe('user-profile/Show'); // its declared base now
    expect(tab.layers.map((layer) => layer.component)).toEqual(['user-profile/Edit']);
  });

  it('saving in the layer closes it — Back in the history — and the profile beneath shows the new name', async () => {
    const ada = await onProfile();
    const entries = tab.entries.length;
    await tab.visit(`/users/${ada.public_id}/edit`, { layer: true });
    await tab.layerVisit(`/users/${ada.public_id}`, { method: 'put', data: { name: 'Ada King', bio: '' } });
    expect(tab.layers).toEqual([]);
    expect(tab.index).toBe(entries - 1);
    expect(tab.visible.props).toMatchObject({ profile: { name: 'Ada King' } });
    // The close delivered it: once, though the profile beneath reloaded after it.
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
  });

  it('after signing out, Back shows no layer — neither the plain text of a token nor the profile form', async () => {
    const ada = await onProfile();
    await tab.visit(`/users/${ada.public_id}/edit`, { layer: true });
    // Signed out underneath (the page's visit, as the session expiring would): a full page load.
    await tab.visit('/logout', { method: 'post' });
    expect(tab.visible.component).toBe('auth/Login');
    while (tab.index > 0) {
      await tab.back();
      expect(tab.layers, `Back to ${tab.entries[tab.index]!.url}`).toEqual([]);
      expect(leaks(tab.visible, 'no token here')).toEqual([]);
    }
  });
});

describe('Actions in a tab — the real app, the real navigator', () => {
  type Link = { id: number; label: string };
  const linksOf = (page: PageObject) => (page.props as { profile: { links: Link[] } }).profile.links.map((link) => link.label);
  const without = (label: string) => (props: Readonly<Record<string, unknown>>) => {
    const profile = props.profile as { links: Link[] };
    return { profile: { ...profile, links: profile.links.filter((link) => link.label !== label) } };
  };

  async function onProfileWithLinks() {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com', email_verified_at: new Date() });
    const { ProfileLinkFactory } = await import('../user-profile/factories/ProfileLinkFactory.ts');
    const [notes, blog] = await Promise.all([
      app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }),
      app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Blog' }),
    ]);
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    expect(linksOf(tab.visible).sort()).toEqual(['Blog', 'Notes']);
    return { ada, notes: notes!, blog: blog! };
  }

  it('removes a link without navigating: the patch at once, then the profile from the server, its toast with the answer — no history entry', async () => {
    const { ada, notes } = await onProfileWithLinks();
    const entries = JSON.stringify(tab.entries);
    const outcome = await tab.action(`/users/${ada.public_id}/links/${notes.id}`, {
      method: 'delete',
      optimistic: tab.optimistic(without('Notes')),
      reload: tab.reloading({ only: ['profile'] }),
    });
    expect(outcome).toMatchObject({ ok: true, kind: 'redirect', redirect: `/users/${ada.public_id}`, flash: [{ key: 'toast', data: { message: 'Link removed.' } }] });
    expect(linksOf(tab.visible)).toEqual(['Blog']);
    expect(tab.toasts).toEqual(['toast: Link removed.']);
    expect(tab.requests.slice(-2)).toEqual([`DELETE /users/${ada.public_id}/links/${notes.id} (visit)`, `GET /users/${ada.public_id} (visit)`]);
    expect(JSON.stringify(tab.entries)).toBe(entries);
  });

  it('someone else’s link: 404 — the patch goes, the list is as it was', async () => {
    const { ada, notes } = await onProfileWithLinks();
    const alan = await app.factory(UserFactory).create();
    const { ProfileLinkFactory } = await import('../user-profile/factories/ProfileLinkFactory.ts');
    const theirs = (await app.factory(ProfileLinkFactory).create({ user_id: alan.id, label: 'Theirs' }))!;
    // Ada's user id with Alan's link: the scoped binding answers 404 (no IDOR).
    const outcome = await tab.action(`/users/${ada.public_id}/links/${theirs.id}`, { method: 'delete', optimistic: tab.optimistic(without('Notes')) });
    expect(outcome).toMatchObject({ ok: false, kind: 'exception', exception: { type: 'server', status: 404 } });
    expect(linksOf(tab.visible).sort()).toEqual(['Blog', 'Notes']);
    expect(notes).toBeDefined();
  });

  it('signed out in another tab, the action is a 401 — its patch goes and stays gone (Back, Forward), nothing is retried', async () => {
    const { ada, notes } = await onProfileWithLinks();
    await tab.visit('/people');
    await tab.back();
    await tab.signOutElsewhere();
    const asked = tab.requests.length;
    const outcome = await tab.action(`/users/${ada.public_id}/links/${notes.id}`, {
      method: 'delete',
      optimistic: tab.optimistic(without('Notes')),
      reload: tab.reloading({ only: ['profile'] }),
    });
    expect(outcome).toMatchObject({ ok: false, kind: 'exception', exception: { type: 'server', status: 401 } });
    expect(tab.requests.slice(asked)).toEqual([`DELETE /users/${ada.public_id}/links/${notes.id} (visit)`]);
    expect(linksOf(tab.visible).sort()).toEqual(['Blog', 'Notes']);
    await tab.forward();
    await tab.back();
    expect(linksOf(tab.visible).sort()).toEqual(['Blog', 'Notes']);
    await app.assertDatabaseHas('profile_links', { id: notes.id });
  });
});


describe('Flash in a tab — exactly once, from whichever answer is shown', () => {
  async function onProfile() {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com', email_verified_at: new Date() });
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    expect(tab.visible.component).toBe('user-profile/Show');
    return ada;
  }
  const save = (ada: { public_id: string }, name: string) => tab.visit(`/users/${ada.public_id}`, { method: 'put', data: { name, bio: '' } });

  it('a save’s toast fires once — not again for a partial reload, a full reload of the page, Back or Forward', async () => {
    const ada = await onProfile();
    await save(ada, 'Ada King');
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
    await tab.navigator.reload({ only: ['activity'] });
    await tab.idle();
    await tab.navigator.reload();
    await tab.idle();
    await tab.visit('/people');
    await tab.back();
    await tab.forward();
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
  });

  it('two saves with the same message are two toasts', async () => {
    const ada = await onProfile();
    await save(ada, 'Ada King');
    await save(ada, 'Ada King');
    expect(tab.toasts).toEqual(['toast: Profile saved.', 'toast: Profile saved.']);
  });

  it('a hover-prefetch while a message waits takes none — the click asks the server, and the toast comes with that page', async () => {
    const ada = await onProfile();
    // Another tab saved; its redirect not followed yet: the message waits in the session.
    await tab.submitElsewhere('PUT', `/users/${ada.public_id}`, { name: 'Ada King', bio: '' });
    await tab.prefetch('/people');
    expect(tab.toasts).toEqual([]);
    const asked = tab.requests.length;
    await tab.visit('/people');
    expect(tab.requests.slice(asked)[0]).toBe('GET /people (visit)'); // not the prefetched page: it said a message waits
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
  });

  it('a layer’s answer delivers a waiting message too — the toast shows over the layer, not lost in it', async () => {
    const ada = await onProfile();
    await tab.submitElsewhere('PUT', `/users/${ada.public_id}`, { name: 'Ada King', bio: '' });
    await tab.visit(`/users/${ada.public_id}/edit`, { layer: true });
    expect(tab.layers.map((layer) => layer.component)).toEqual(['user-profile/Edit']);
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
    await tab.back();
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
  });

  it('an action delivers its message with the answer — and no reload after it brings it again', async () => {
    const ada = await onProfile();
    const outcome = await tab.action(`/users/${ada.public_id}/links`, { data: { label: 'Blog', url: 'https://blog.example' }, reload: tab.reloading({ only: ['profile'] }) });
    expect(outcome).toMatchObject({ ok: true, kind: 'redirect', flash: [{ key: 'toast', data: { kind: 'success', message: 'Link added.' } }] });
    expect(tab.toasts).toEqual(['toast: Link added.']);
    await tab.navigator.reload();
    await tab.idle();
    await tab.visit('/people');
    expect(tab.toasts).toEqual(['toast: Link added.']);
  });

  it('signing out: the message survives the 409 and shows on the login page — once', async () => {
    await onProfile();
    await tab.visit('/logout', { method: 'post' });
    expect(tab.visible.component).toBe('auth/Login');
    expect(tab.toasts).toEqual(['toast: You have been signed out.']);
  });
});
