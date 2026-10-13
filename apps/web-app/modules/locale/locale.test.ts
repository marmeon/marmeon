import { UserFactory, UserRepository, type User } from '#modules/auth';
import { LOCATION_HEADER } from '@marmeon/http';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { LoginController } from '../auth/controllers/LoginController.ts';
import type { RegisterController } from '../auth/controllers/RegisterController.ts';
import { ResetPasswordMail } from '../auth/mail/ResetPasswordMail.ts';
import { WARM_UP_TIMEOUT, warmUp } from '../auth/warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const german = { 'accept-language': 'de-DE,de;q=0.9,en;q=0.5' };
const referer = (path: string) => ({ referer: `http://localhost${path}` });

describe('a German browser', () => {
  it('gets the pages in German — the page carries only its locale', async () => {
    const login = await app.withHeaders(german).navigating().get('/login').assertOk();
    expect(login.page()).toMatchObject({ component: 'auth/Login', locale: 'de' });
    expect(login.headers.get('content-language')).toBe('de');
    expect(JSON.stringify(login.page()!.props)).not.toContain('Anmelden'); // the texts come from the language files, not with the page
    const english = await app.navigating().get('/login');
    expect(english.page()!.locale).toBe('en');
  });

  it('gets German validation errors on the field — its own messages, the framework’s rules (password(), confirmed()) and what they require', async () => {
    await app
      .withHeaders(german)
      .post('/login', { form: { email: 'not an address', password: '' }, headers: referer('/login') })
      .assertRedirect('/login')
      .assertInvalid<LoginController>({ email: 'Bitte gib eine gültige E-Mail-Adresse ein.', password: 'Bitte gib dein Passwort ein.' });

    await app
      .withHeaders(german)
      .post('/register', { form: { name: 'A', email: 'a@example.com', password: 'short', password_confirmation: 'other' }, headers: referer('/register') })
      .assertInvalid<RegisterController>({ name: 'Der Name braucht mindestens 2 Zeichen.', password: 'Das Passwort braucht mindestens 8 Zeichen.' });
    // The confirmation is compared once the password itself is valid (confirmed() of the rules).
    await app
      .withHeaders(german)
      .post('/register', { form: { name: 'Ada', email: 'a@example.com', password: 'correct horse', password_confirmation: 'other' }, headers: referer('/register') })
      .assertInvalid<RegisterController>({ password_confirmation: 'Die Passwörter stimmen nicht überein.' });

    // Messages a controller writes itself, with the translator: wrong credentials.
    const ada = await app.factory(UserFactory).create();
    await app.withHeaders(german).post('/login', { form: { email: ada.email, password: 'wrong' }, headers: referer('/login') }).assertInvalid<LoginController>({
      email: 'Diese Zugangsdaten passen zu keinem Konto.',
    });

    // And JSON clients (422) alike.
    const json = await app.withHeaders(german).expectingJson().post('/login', { json: { email: 'x', password: 'y' } }).assertStatus(422);
    expect(json.json()).toMatchObject({ errors: { email: ['Bitte gib eine gültige E-Mail-Adresse ein.'] } });
  });

  it('gets the error page in German (404, the framework’s texts by key)', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).withHeaders(german).navigating().get('/users/999999').assertNotFound().assertPage('errors/Error', { title: 'Nicht gefunden', message: 'Nicht gefunden' });
    await app.actingAs(ada).navigating().get('/users/999999').assertPage('errors/Error', { title: 'Not Found' });
  });

  it('two requests at the same time, one German, one English: each gets its own language', async () => {
    const [de, en] = await Promise.all([app.withHeaders(german).navigating().get('/register'), app.navigating().get('/register')]);
    expect([de.page()!.locale, en.page()!.locale]).toEqual(['de', 'en']);
    const [deInvalid, enInvalid] = await Promise.all([
      app.withHeaders(german).expectingJson().post('/login', { json: { email: 'x', password: 'y' } }),
      app.expectingJson().post('/login', { json: { email: 'x', password: 'y' } }),
    ]);
    expect([deInvalid.json(), enInvalid.json()]).toMatchObject([{ errors: { email: ['Bitte gib eine gültige E-Mail-Adresse ein.'] } }, { errors: { email: ['Enter a valid e-mail address.'] } }]);
  });
});

describe('the language switcher (POST /locale)', () => {
  it('keeps the choice in the session — it wins over the browser’s languages', async () => {
    const switched = await app.post('/locale', { form: { locale: 'de' }, headers: referer('/login') }).assertRedirect('/login').assertSessionHas('locale', 'de');
    // A full page load from here on, without Clear-Site-Data: the browser's cache is left alone.
    expect(switched.headers.has('clear-site-data')).toBe(false);
    const session = app.withCookie('marmeon_session', switched.cookie('marmeon_session')!);
    const login = await session.navigating().get('/login', { headers: { 'accept-language': 'en' } });
    expect(login.page()!.locale).toBe('de');
    login.assertFlash('toast', { message: 'Sprache geändert.' });
  });

  it('answers a client-side visit with a full page load (409): the pages kept in memory are in the old language', async () => {
    const visit = await app.navigating().post('/locale', { form: { locale: 'de' }, headers: referer('/register') }).assertStatus(409);
    expect(visit.headers.get(LOCATION_HEADER)).toBe('/register');
    expect(visit.headers.has('clear-site-data')).toBe(false);
  });

  it('takes only a supported locale — in its spelling; anything else is a validation error', async () => {
    await app.post('/locale', { form: { locale: 'DE' }, headers: referer('/login') }).assertSessionHas('locale', 'de');
    for (const locale of ['fr', '../../etc/passwd', 'de"><script>']) {
      await app.withHeaders(german).post('/locale', { form: { locale }, headers: referer('/login') }).assertRedirect('/login').assertSessionMissing('locale');
    }
    const invalid = await app.withHeaders(german).expectingJson().post('/locale', { json: { locale: 'xx' } }).assertStatus(422);
    expect(invalid.json()).toMatchObject({ errors: { locale: ['Diese Sprache gibt es nicht.'] } });
  });

  it('stores the choice in the account when signed in — another device starts in it; signing out keeps it', async () => {
    const ada = await app.factory(UserFactory).create();
    const switched = await app.actingAs(ada).post('/locale', { form: { locale: 'de' }, headers: referer('/users/me') });
    await app.assertDatabaseHas('users', { id: ada.id, locale: 'de' });
    // Another device: no session choice, an English browser — the account's language.
    expect((await app.actingAs(ada).navigating().get(`/users/${ada.id}`, { headers: { 'accept-language': 'en' } })).page()!.locale).toBe('de');

    const session = app.withCookie('marmeon_session', switched.cookie('marmeon_session')!);
    const out = await session.post('/logout').assertRedirect('/login').assertGuest().assertSessionHas('locale', 'de');
    (await app.withCookie('marmeon_session', out.cookie('marmeon_session')!).navigating().get('/login')).assertFlash('toast', { message: 'Du wurdest abgemeldet.' });
  });
});

describe('mails in the recipient’s language', () => {
  const ask = (email: string, headers: Record<string, string> = {}) =>
    app.withHeaders(headers).post('/forgot-password', { form: { email }, headers: referer('/forgot-password') });
  /** The last reset mail — composed by the worker (no request there), queued for the transport. */
  const lastMail = async () => {
    await app.queue.work();
    return app.mail.queued(ResetPasswordMail).at(-1)!.message;
  };

  it('a reset link asked for in German, for an account in English, is in English — the account’s language wins', async () => {
    const ada = await app.factory(UserFactory).create({ name: 'Ada', locale: 'en' });
    await ask(ada.email, german).assertFlashed('toast', { message: 'Falls es zu dieser Adresse ein Konto gibt, haben wir einen Link zum Zurücksetzen des Passworts geschickt.' });
    expect((await lastMail()).subject).toBe('Reset your password');
    expect((await lastMail()).text).toContain('Hello Ada,');
    expect((await lastMail()).html).toContain('<html lang="en"');
  });

  it('…and the other way round; without a stored language, the request’s', async () => {
    const grace = await app.factory(UserFactory).create({ name: 'Grace', locale: 'de' });
    await ask(grace.email).assertFlashed('toast', { message: 'If an account exists for that address, we sent a link to reset its password.' });
    expect((await lastMail()).subject).toBe('Passwort zurücksetzen');
    expect((await lastMail()).text).toContain('Hallo Grace,');
    expect((await lastMail()).text).toContain('Der Link funktioniert einmal, 60 Minuten lang.');

    const alan = await app.factory(UserFactory).create({ name: 'Alan', locale: null });
    await ask(alan.email, german);
    expect((await lastMail()).subject).toBe('Passwort zurücksetzen');
  });

  it('registering stores the language the account was made in (its verification mail is in it)', async () => {
    await app.withHeaders(german).post('/register', { form: { name: 'Katherine', email: 'kj@example.com', password: 'orbital mechanics', password_confirmation: 'orbital mechanics' } });
    const user = (await app.make(UserRepository).query().selectAll().where('email', '=', 'kj@example.com').executeTakeFirst()) as User;
    expect(user.locale).toBe('de');
  });
});
