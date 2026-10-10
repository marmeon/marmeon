import { RateLimiter } from '@marmeon/cache';
import { ACTION_REDIRECT_HEADER, VALIDATED_HEADER } from '@marmeon/http/page';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { RegisterController } from './controllers/RegisterController.ts';
import { UserFactory } from './factories/UserFactory.ts';

/**
 * Live validation on the server: the form's own route, as far as its validation — middleware, `authorize`, the schema —
 * never its controller; read-only, rate-limited, CSRF-protected.
 */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});
afterEach(async () => {
  await app.close();
});

const registration = { name: 'Ada Lovelace', email: 'ada@example.com' };

describe('live validation of the registration', () => {
  it('answers 204 for valid fields — and never registers anyone', async () => {
    await app.validating('name', 'email').post('/register', { json: registration }).assertLiveValid('name', 'email');
    await app.assertDatabaseMissing('users', { email: 'ada@example.com' });
    app.mail.assertNothingSent();
  });

  it('answers only for the fields it names — an untouched field (empty name, no password at all) is no error', async () => {
    const response = await app.validating('email').post('/register', { json: { name: '', email: 'nope' } }).assertUnprocessable();
    response.assertInvalid<RegisterController>({ email: 'Enter a valid e-mail address.' });
    expect(Object.keys(response.json<{ errors: object }>().errors)).toEqual(['email']);
    expect(response.headers.get(VALIDATED_HEADER)).toBe('email');
    // Never the input back: no `old`, no value.
    expect(response.body).not.toContain('nope');
  });

  it('never tells whether an address has an account — like the submit (private registration)', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const known = await app.validating('email').post('/register', { json: { email: ' ADA@example.com ' } }).assertLiveValid('email');
    const unknown = await app.validating('email').post('/register', { json: { email: 'grace@example.com' } }).assertLiveValid('email');
    expect([known.status, known.body]).toEqual([unknown.status, unknown.body]);
    // Only the form of the address is checked.
    await app.validating('email').post('/register', { json: { email: 'not an address' } }).assertInvalid<RegisterController>({ email: 'Enter a valid e-mail address.' });
  });

  it('the login tells nothing about accounts: a known and an unknown address get the same answer', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const known = await app.validating('email', 'password').post('/login', { json: { email: 'ada@example.com', password: 'wrong' } });
    const unknown = await app.validating('email', 'password').post('/login', { json: { email: 'nobody@example.com', password: 'wrong' } });
    expect([known.status, known.body]).toEqual([204, '']);
    expect([unknown.status, unknown.body]).toEqual([204, '']);
  });

  it('in the request’s language (Accept-Language: de)', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const response = await app.withHeaders({ 'accept-language': 'de' }).validating('name', 'email').post('/register', { json: { name: 'A', email: 'ada@' } });
    response.assertInvalid<RegisterController>({ name: 'Der Name braucht mindestens 2 Zeichen.', email: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
  });

  it("a signed-in visitor's check is no result: the guest-only route's redirect is reported, not followed", async () => {
    const ada = await app.factory(UserFactory).create();
    const response = await app.actingAs(ada).validating('email').post('/register', { json: registration }).assertNoContent();
    expect(response.headers.get(ACTION_REDIRECT_HEADER)).toBe('/users/me');
    expect(response.headers.get(VALIDATED_HEADER)).toBeNull();
  });
});

describe('live validation changes nothing (read-only)', () => {
  it('never writes the session nor sets a cookie — a waiting flash message stays for the page', async () => {
    const ada = await app.factory(UserFactory).create();
    const saved = await app.actingAs(ada).put(`/users/${ada.id}`, { json: { name: 'Ada King', bio: '' } }).assertRedirect(`/users/${ada.id}`);
    const browser = app.withCookie('marmeon_session', saved.cookie('marmeon_session')!);
    const live = await browser.validating('name').put(`/users/${ada.id}`, { json: { name: 'Ada Byron', bio: '' } }).assertLiveValid('name').assertNoFlash();
    expect(live.headers.get('set-cookie')).toBeNull();
    expect(live.headers.get('cache-control')).toBe('no-store');
    // Nothing saved by the check, and the message still waits — the next page shows it.
    await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada King' });
    await browser.navigating().get('/people').assertOk().assertFlash('toast', { message: 'Profile saved.' });
  });

  it("never touches the login's throttle: checks of the sign-in form leave all its tries", async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    for (let i = 0; i < 6; i++) await app.validating('email', 'password').post('/login', { json: { email: 'ada@example.com', password: 'wrong' } }).assertLiveValid();
    expect(await app.make(RateLimiter).attempts('login:ada@example.com|unknown')).toBe(0);
    await app.post('/login', { form: { email: 'ada@example.com', password: 'password' } }).assertRedirect('/users/me').assertAuthenticated(ada);
  });

  it("never counts against a route's throttle: the reset form's five tries a minute stay", async () => {
    for (let i = 0; i < 6; i++) await app.validating('email').post('/forgot-password', { json: { email: 'ada@example.com' } }).assertLiveValid();
    for (let i = 0; i < 5; i++) await app.post('/forgot-password', { form: { email: 'ada@example.com' }, headers: { referer: 'http://localhost/forgot-password' } }).assertRedirect();
    await app.post('/forgot-password', { form: { email: 'ada@example.com' } }).assertStatus(429);
  });
});

describe('live validation is held to the route’s rules', () => {
  it('authorization first: checking another person’s profile is a 403 — no field errors', async () => {
    const ada = await app.factory(UserFactory).create();
    const alan = await app.factory(UserFactory).create();
    const response = await app.actingAs(ada).validating('name').put(`/users/${alan.id}`, { json: { name: 'A', bio: '' } }).assertForbidden();
    expect(response.json<object>()).not.toHaveProperty('errors');
    await app.actingAs(ada).validating('name').put(`/users/${ada.id}`, { json: { name: 'A', bio: '' } }).assertInvalid(['name']);
  });

  it('a guest checking the profile form is sent away (authentication runs first)', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.validating('name').put(`/users/${ada.id}`, { json: { name: 'A', bio: '' } }).assertStatus(401);
  });

  it('30 checks a minute per address and form, then 429 — the form itself can still be sent', async () => {
    for (let i = 0; i < 30; i++) await app.validating('email').post('/register', { json: { email: `person${i}@example.com` } }).assertLiveValid();
    const limited = await app.validating('email').post('/register', { json: { email: 'ada@example.com' } }).assertStatus(429);
    expect(limited.body).not.toContain('registered');
    await app.post('/register', { form: { ...registration, password: 'correct horse', password_confirmation: 'correct horse' }, headers: { referer: 'http://localhost/register' } }).assertRedirect('/register/sent');
  });

  it('is held to CSRF like the submit: the browser\'s word or the token — a guest from elsewhere gets 403', async () => {
    await app.close();
    app = await createTestApp(application, { csrf: true, database: 'refresh' });
    const page = await app.navigating().get('/register');
    expect(page.page()!.csrf).toBeUndefined(); // a guest: no session, no token
    await app.validating('name').post('/register', { json: { name: 'Ada' } }).assertStatus(419);
    await app.withHeaders({ 'sec-fetch-site': 'cross-site' }).validating('name').post('/register', { json: { name: 'Ada' } }).assertStatus(403);
    await app.withHeaders({ 'sec-fetch-site': 'same-origin' }).validating('name').post('/register', { json: { name: 'Ada' } }).assertLiveValid('name');
  });
});
