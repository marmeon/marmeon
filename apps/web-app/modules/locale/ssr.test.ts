import { UserFactory } from '#modules/auth';
import { ProfileLinkFactory } from '../user-profile/factories/ProfileLinkFactory.ts';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

// Vitest's 5 s is too short under load: more time on CI runners only (CI=true).
const ciTimeout = process.env.CI === 'true' ? 15_000 : undefined;

// Server rendering with the language files: the SSR entry loads the page's locale before rendering (streaming).
let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', ssr: true });
});

const html = (language: string) => ({ headers: { accept: 'text/html', 'accept-language': language } });

describe('translated pages, rendered on the server', () => {
  it('renders German markup in <html lang="de"> — and it hydrates from the same messages', async () => {
    const response = await app.get('/login', html('de')).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toContain('<html lang="de">');
    expect(response.body).toContain('<title data-marmeon-head="ssr">Anmelden — Marmeon</title>');
    // One text node: the app name is a placeholder of the message, not glued around it.
    expect(response.body).toContain('<h1>Bei Marmeon (test) anmelden</h1>');
    expect(response.body).toContain('Angemeldet bleiben');
    expect(response.body).not.toContain('Keep me signed in');

    const english = await app.get('/login', html('en')).assertServerRendered().assertHydrates();
    expect(english.body).toContain('<html lang="en">');
    expect(english.body).toContain('Keep me signed in');
  }, ciTimeout);

  it('formats for the locale: plurals, dates, relative times', async () => {
    const ada = await app.factory(UserFactory).create({ name: 'Ada', created_at: '2026-01-15T10:00:00.000Z' });
    const response = await app.actingAs(ada).get(`/users/${ada.id}`, html('de')).assertServerRendered().assertHydrates();
    expect(response.body).toContain('Mitglied seit 15. Januar 2026');
    expect(response.body).toContain('Letzte Aktivität');
  });

  it('a translated text is text: markup in a value is escaped, never HTML', async () => {
    const mallory = await app.factory(UserFactory).create({ name: 'Mallory' });
    const label = '"><img src=x onerror=alert(1)>';
    await app.factory(ProfileLinkFactory).create({ user_id: mallory.id, label });
    // "{label} entfernen" goes into an attribute (aria-label) through t(): React escapes the filled text there too.
    const profile = await app.actingAs(mallory).get(`/users/${mallory.id}`, html('de')).assertServerRendered().assertHydrates();
    expect(profile.body).not.toContain('<img src=x');
    expect(profile.body).toContain('aria-label="&quot;&gt;&lt;img src=x onerror=alert(1)&gt; entfernen"');
  });
});

describe('a path without a route', () => {
  it('is a 404 page in the layout — no group ran, so no shared props: the layout renders without them, on the server and in the browser', async () => {
    const response = await app.get('/gibt-es-nicht', html('en')).assertNotFound().assertServerRendered().assertHydrates();
    expect(response.body).toContain('Not Found');
    // The layout's header — for a guest, without the language switcher (no `locales` without the `web` group) and without a session.
    expect(response.body).toContain('Sign in');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
