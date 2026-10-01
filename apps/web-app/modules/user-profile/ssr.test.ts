import { UserRepository, type User } from '#modules/auth';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

// Server rendering in tests (W5 step 7): through the app's Vite setup, so markup and <Head> are testable.
let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true, ssr: true });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

const page = { headers: { accept: 'text/html' } };

describe('the profile page, rendered on the server', () => {
  it('hydrates: what the server rendered is what the browser renders from the page object — dates included (W5.1 finding)', async () => {
    // A sign-in leaves a timestamp with milliseconds: before W5.7 the server rendered it from a Date
    // ("29 seconds ago" vs "28" in the browser, and a `dateTime` the browser never sees).
    await app.post('/login', { form: { email: alan.email, password: 'password' } }).assertRedirect('/users/me');
    const response = await app.actingAs(ada).get(`/users/${alan.id}`, page).assertOk().assertServerRendered().assertHydrates();
    const { lastLoginAt } = response.page()!.props as { lastLoginAt: string };
    expect(response.body).toContain(`<time dateTime="${lastLoginAt}"`);
  });

  it('puts the page’s <Head> into the document head — title through the template, meta tags (Merkposten W2)', async () => {
    await app
      .actingAs(ada)
      .get(`/users/${alan.id}`, page)
      .assertServerRendered()
      .assertSee('<title data-bespoke-head="ssr">Alan Turing — BespokeCore</title><meta name="description" content="Computability pioneer." data-bespoke-head="ssr"/>')
      .assertSee('<h1>Alan Turing</h1>');
  });

  it('renders the people list with links on the server (and it hydrates)', async () => {
    const response = await app.actingAs(ada).get(`/users/${ada.id}`, page).assertServerRendered().assertHydrates();
    expect(response.body).toContain(`<a href="/users/${alan.id}">Alan Turing</a>`);
    expect(response.body).toContain('Loading activity…'); // deferred: the browser loads it next
  });
});
