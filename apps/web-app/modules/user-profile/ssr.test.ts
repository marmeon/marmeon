import { UserFactory, UserRepository, type User } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';

// Server rendering in tests: through the app's Vite setup, so markup and <Head> are testable.
let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true, ssr: true });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
}, 30_000); // each test starts its own Vite server — seconds on a busy machine

const page = { headers: { accept: 'text/html' } };

describe('the profile page, rendered on the server', { timeout: 30_000 }, () => {
  it('hydrates: what the server rendered is what the browser renders from the page object — dates included', async () => {
    // A sign-in leaves a timestamp with milliseconds: rendered from a Date, the server would say "29 seconds ago" where the
    // browser says "28" (and write a `dateTime` the browser never sees).
    await app.post('/login', { form: { email: alan.email, password: 'password' } }).assertRedirect('/users/me');
    const response = await app.actingAs(ada).get(`/users/${alan.public_id}`, page).assertOk().assertServerRendered().assertHydrates();
    const { lastLoginAt } = response.page()!.props as { lastLoginAt: string };
    expect(response.body).toContain(`<time dateTime="${lastLoginAt}"`);
  });

  it('puts the page’s <Head> into the document head — title through the template, meta tags', async () => {
    await app
      .actingAs(ada)
      .get(`/users/${alan.public_id}`, page)
      .assertServerRendered()
      .assertSee('<title data-marmeon-head="ssr">Alan Turing — Marmeon</title><meta name="description" content="Computability pioneer." data-marmeon-head="ssr"/>')
      .assertSee('<h1>Alan Turing</h1>');
  });

  it('hydrates the pages with a link that sends — a <Link> to an action renders a form, which no <p> may hold', async () => {
    const grace = await app.factory(UserFactory).state('unverified').create();
    const link = await app.factory(ProfileLinkFactory).create({ user_id: ada.id });
    await app.actingAs(grace).get('/email/verify', page).assertOk().assertHydrates(); // "resend the mail"
    await app.actingAs(ada).get(`/users/${ada.public_id}/links/${link.id}/remove`, page).assertOk().assertHydrates(); // the layer's "Remove"
  });

  it('renders with the deferred part still loading (and it hydrates)', async () => {
    const response = await app.actingAs(ada).get(`/users/${ada.public_id}`, page).assertServerRendered().assertHydrates();
    expect(response.body).toContain('<a href="/people">All people</a>');
    expect(response.body).toContain('Loading activity…'); // deferred: the browser loads it next
  });
});

describe('view transitions: the avatars the list and the profile share, rendered on the server', { timeout: 30_000 }, () => {
  it('without inline styles — view-transition-name only through the CSSOM (React, during a transition): a strict style-src blocks none', async () => {
    await app.make(UserRepository).update(ada.id, { avatar_path: 'avatars/ada.png' });
    for (const url of ['/people', `/users/${ada.public_id}`]) {
      const { body } = await app.actingAs(ada).get(url, page).assertOk().assertServerRendered();
      const avatars = body.match(/<img[^>]*avatars\/ada\.png[^>]*>/g) ?? [];
      expect(avatars.length, `${url}: no avatar rendered`).toBeGreaterThan(0);
      const styled = [...avatars, ...(body.match(/<[^>]+view-transition[^>]*>/g) ?? [])].filter((tag) => /\sstyle=|view-transition-name/.test(tag));
      expect(styled, `${url}: inline styles in the server's markup — ${styled.join(' ')}`).toEqual([]);
      expect(body, 'the app’s stylesheet (the animations live there, not inline)').toMatch(/<link rel="stylesheet" href="[^"]*app[^"]*\.css"/);
    }
  });
});

describe('the app’s pages, rendered on the server', { timeout: 30_000 }, () => {
  it('carry no style attribute — the views name classes of styles/app.css (a strict style-src would block one)', async () => {
    // Signed in for real: a fresh sign-in counts as a confirmed password (the settings pages are in sudo mode).
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect('/users/me');
    const session = app.withCookie('marmeon_session', login.cookie('marmeon_session')!);
    for (const url of ['/dashboard', '/people', `/users/${ada.public_id}`, `/users/${ada.public_id}/edit`, '/members', '/notifications', '/settings/security', '/settings/tokens']) {
      const { body } = await session.get(url, page).assertOk().assertServerRendered();
      // The framework's LayerDialog too: its look is classes of @marmeon/react/styles.css.
      const styled = body.match(/<[^>]+\sstyle="[^>]*>/g) ?? [];
      expect(styled, `${url}: inline styles in the server's markup — ${styled.join(' ')}`).toEqual([]);
    }
  });
});

describe('the people list, rendered on the server — its query state included', { timeout: 30_000 }, () => {
  it('renders the filtered, sorted list from the URL, and it hydrates: useQueryState reads the parsed query of the page', async () => {
    const response = await app.actingAs(ada).get('/people?q=a&sort=-name', page).assertServerRendered().assertHydrates();
    expect(response.body).toContain('value="a"'); // the search field holds the query
    expect(response.body.indexOf('>Grace Hopper</a>')).toBeLessThan(response.body.indexOf('>Ada Lovelace</a>'));
    expect(response.body).toContain(`<a href="/users/${alan.public_id}">Alan Turing</a>`);
    // The sort links: defaults left out of their URLs (`q` stays — it is no default), the current one marked.
    expect(response.body).toContain('<a href="/people?q=a">Name A–Z</a>');
    expect(response.body).toContain('href="/people?q=a&amp;sort=-name" aria-current="true"');
  });

  it('falls back on an invalid query on the server as well — the default sort, the search field empty', async () => {
    const response = await app.actingAs(ada).get('/people?sort=DROP%20TABLE&q=' + 'x'.repeat(61), page).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toContain('value=""');
    expect(response.body.indexOf('>Ada Lovelace</a>')).toBeLessThan(response.body.indexOf('>Grace Hopper</a>'));
  });
});

describe('a deep link of a layer, rendered on the server', { timeout: 30_000 }, () => {
  it('renders the edit layer over the profile in one document — and it hydrates', async () => {
    const response = await app.actingAs(ada).get(`/users/${ada.public_id}/edit`, page).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toContain('<dialog open="" data-marmeon-layer="user-profile/Edit"');
    expect(response.body).toContain('<h1>Ada Lovelace</h1>');
  });

  it('stacks the profile, the edit layer and the confirmation in one document — and it hydrates', async () => {
    const link = await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Blog' });
    const response = await app.actingAs(ada).get(`/users/${ada.public_id}/links/${link.id}/remove`, page).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toContain('<h1>Ada Lovelace</h1>');
    expect(response.body.match(/<dialog open="" data-marmeon-layer="user-profile\/(Edit|RemoveLink)"/g)).toHaveLength(2);
    // Their frames carry no style attribute: classes of @marmeon/react/styles.css, linked by the built index.html.
    const styled = response.body.match(/<[^>]+\sstyle="[^>]*>/g) ?? [];
    expect(styled, `inline styles in the server's markup — ${styled.join(' ')}`).toEqual([]);
    expect(response.body).toMatch(/<dialog open="" data-marmeon-layer="user-profile\/Edit"[^>]* class="marmeon-layer marmeon-layer--(modal|slideover)[ "]/);
  });
});

describe('the people list’s page links, rendered on the server', { timeout: 30_000 }, () => {
  it('speak the reader’s language — the app’s words (layouts/Pagination.tsx), links from the parsed query', async () => {
    await app.factory(UserFactory).count(12).create(); // 15 people: two pages
    const german = await app.actingAs(ada).get('/people?page=2&sort=-name', { headers: { ...page.headers, 'accept-language': 'de' } }).assertServerRendered().assertHydrates();
    expect(german.body, 'the page links are not German').toContain('<nav aria-label="Seitennavigation">');
    expect(german.body).toContain('‹ Zurück');
    expect(german.body).toContain('href="/people?sort=-name" aria-label="Seite 1"');
    const english = await app.actingAs(ada).get('/people', { headers: { ...page.headers, 'accept-language': 'en' } }).assertServerRendered();
    expect(english.body).toContain('<nav aria-label="Pagination">');
    expect(english.body).toContain('aria-label="Page 2"');
  });
});
