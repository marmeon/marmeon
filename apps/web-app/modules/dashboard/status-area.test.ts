import { UserFactory, UserRepository, type User } from '#modules/auth';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

// The status board package's area, in the app: its route behind the app's access check, its page in a document of its own with its own
// policy and texts (the app rewords one in German), and the visits across the boundary between that document and the app's.
let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true, ssr: true, ssrServer: server });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

const html = (language = 'en') => ({ headers: { accept: 'text/html', 'accept-language': language } });
/** The client of the area's document: it names its entry with every visit. */
const area = (target: TestApp) => target.navigating().withHeaders({ 'x-marmeon-entry': 'status' });

describe("the area's route", () => {
  it('turns a guest to the sign-in, and a member the app has not admitted away', async () => {
    const guest = await app.get('/status', html()).assertRedirect('/login');
    expect(guest.body).not.toContain('data-area');
    // Alan is a member, but the dashboard's administrators are the app's decision (DASHBOARD_ADMINS): 403, no document of the area.
    const member = await app.actingAs(alan).get('/status', html()).assertForbidden();
    expect(member.body).not.toContain('data-area');
    expect(member.body).not.toContain('area/client');
  });

  it('refuses an account that has not confirmed its address, even with an administrator’s address, and lets the confirmed one in', async () => {
    // The default administrator address, on an account that never confirmed it (a sign-up can use any address).
    const users = app.make(UserRepository);
    await users.update(ada.id, { email: 'former-admin@example.com' });
    const unconfirmed = await app.factory(UserFactory).state('unverified').create({ email: 'ada@example.com' });
    const refused = await app.actingAs(unconfirmed).get('/status', html()).assertForbidden();
    expect(refused.body).not.toContain('data-area');
    await users.update(unconfirmed.id, { email_verified_at: new Date().toISOString() });
    await app.actingAs(unconfirmed).get('/status', html()).assertOk();
  });

  it('refuses everybody while the app binds no access', async () => {
    // Without the dashboard module nothing binds `StatusAccess`: the administrator of the other tests is refused like anybody.
    await app.close();
    const unbound = await createTestApp({ ...application, modules: application.modules!.filter((module) => module.name !== 'dashboard') }, { database: 'refresh', seed: true });
    const [admin] = (await unbound.make(UserRepository).query().selectAll().orderBy('id').execute()) as User[];
    await unbound.actingAs(admin!).get('/status', html()).assertForbidden();
    await unbound.close();
  });

  it('shows an administrator the area in its own document, server-rendered, and it hydrates', async () => {
    const response = await app.actingAs(ada).get('/status', html()).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toContain('data-area="status"');
    expect(response.body).toContain('<h1>Service status</h1>');
    // The package's component on its own page, with the data of its controller.
    expect(response.body).toMatch(/<span data-badge="" data-state="degraded">degraded<\/span>/);
    // The package's entry, and none of the app's.
    expect(response.body).toMatch(/<script[^>]* src="[^"]*\/area\/client\.tsx"/);
    expect(response.body).not.toContain('/bootstrap/client.tsx');
  });
});

describe("the area's policy", () => {
  it('is the one its route group sets (not the app’s), with the response’s nonce on the entry script', async () => {
    const response = await app.actingAs(ada).get('/status', html()).assertOk();
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toMatch(/^script-src 'nonce-[^']+' 'strict-dynamic'; object-src 'none'; base-uri 'self'; style-src 'self' 'nonce-[^']+'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'$/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)![1];
    expect(response.body).toMatch(new RegExp(`<script[^>]* nonce="${nonce!.replace(/[+/=]/g, '\\$&')}"`));
    // The app's page has its own policy: no `img-src`, no `connect-src`.
    const dashboard = await app.actingAs(ada).get('/dashboard', html()).assertOk();
    expect(dashboard.headers.get('content-security-policy')).not.toMatch(/img-src|connect-src/);
  });
});

describe("the area's texts", () => {
  it('are the package’s, in the visitor’s language', async () => {
    const english = await app.actingAs(ada).get('/status', html('en')).assertOk();
    expect(english.body).toContain('<h1>Service status</h1>');
    expect(english.body).toContain('Back to the app');
  });

  it('show the app’s rewording of a text, and every other text stays the package’s', async () => {
    const response = await app.actingAs(ada).get('/status', html('de')).assertOk().assertServerRendered().assertHydrates();
    // `lang/status/de.ts` of the app rewords `title`; `back` is the package's German text.
    expect(response.body).toContain('<h1>Systemzustand</h1>');
    expect(response.body).not.toContain('Dienststatus');
    expect(response.body).toContain('Zurück zur App');
  });
});

describe('the boundary between the area and the app', () => {
  it('loads a visit from the app into the area fully: 409 with the area’s address', async () => {
    const visit = await app.actingAs(ada).navigating().get('/status').assertStatus(409);
    expect(visit.headers.get('x-marmeon-reload')).toBe('entry');
    expect(visit.headers.get('x-marmeon-location')).toBe('/status');
    expect(visit.body).not.toContain('Service status');
  });

  it('loads a visit from the area back into the app fully, and a visit within either document stays a visit', async () => {
    const back = await area(app.actingAs(ada)).get('/dashboard').assertStatus(409);
    expect([back.headers.get('x-marmeon-reload'), back.headers.get('x-marmeon-location')]).toEqual(['entry', '/dashboard']);
    await area(app.actingAs(ada)).get('/status').assertOk().assertPage('status::Index');
    await app.actingAs(ada).navigating().get('/dashboard').assertOk().assertPage('dashboard/Show', {});
  });

  it('links from the area to the app, and from the app to the area', async () => {
    const inArea = await app.actingAs(ada).get('/status', html()).assertOk();
    expect(inArea.body).toMatch(/<a [^>]*href="\/dashboard"[^>]*>Back to the app<\/a>/);
    const inApp = await app.actingAs(ada).get('/dashboard', html()).assertOk();
    expect(inApp.body).toMatch(/<a [^>]*href="\/status"[^>]*>Open the status area<\/a>/);
    // The app's page is the app's document: the area's entry is not in it.
    expect(inApp.body).not.toContain('area/client');
  });
});
