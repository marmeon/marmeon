import { UserFactory, UserRepository, type User } from '#modules/auth';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

// Vitest's 5 s is too short under load: more time on CI runners only (CI=true).
const ciTimeout = process.env.CI === 'true' ? 15_000 : undefined;

// Islands in the SSR stream: resolved in-process while the page renders — rendered completely here, as for a bot.
let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true, ssr: true, ssrServer: server, env: { DASHBOARD_ADMINS: 'ada@example.com' } });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

const document = { headers: { accept: 'text/html' } };
/** The data blocks of the islands in a document, parsed. */
const islandsIn = (html: string) =>
  [...html.matchAll(/<script type="application\/json" id="marmeon-island-[^"]*">(.*?)<\/script>/g)].map(([, json]) => JSON.parse(json!) as { status: string; region?: { component: string; props: Record<string, unknown> } });

describe('test apps that share the Vite server', () => {
  it('render what is theirs: the signed-in user of one app is nowhere in the next one’s page', async () => {
    const probe = await app.factory(UserFactory).create({ name: 'Leak Probe', email: 'leak-probe@example.com' });
    await app.actingAs(probe).get('/dashboard', document).assertOk().assertServerRendered().assertSee(probe.name);
    await app.close();

    const next = await createTestApp(application, { database: 'refresh', ssr: true, ssrServer: server });
    await next.get('/login', document).assertOk().assertServerRendered().assertDontSee(probe.name).assertDontSee(probe.email);
  }, ciTimeout);
});

describe('the dashboard, rendered on the server with its islands', () => {
  it('has every eager island in the HTML — with its data, for the browser to show without a request — and hydrates', async () => {
    const response = await app.actingAs(ada).get('/dashboard', document).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toMatch(/data-island="dashboard\.sign-ins" data-status="ready"/);
    expect(response.body).toMatch(/data-island="dashboard\.members" data-status="ready"/);
    // `load="visible"` is never resolved on the server.
    expect(response.body).toMatch(/data-island="dashboard\.activity" data-status="loading"/);
    const islands = islandsIn(response.body);
    expect(islands.map((island) => island.region?.component).sort()).toEqual(['dashboard/MemberStats', 'dashboard/RecentSignIns']);
    expect(islands.find((island) => island.region?.component === 'dashboard/MemberStats')!.region!.props).toMatchObject({ stats: { members: 3, verified: 3 } });
  });

  it('an island its route refuses streams no data — the fallback, only its outcome', async () => {
    const response = await app.actingAs(alan).get('/dashboard', document).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toMatch(/data-island="dashboard\.members" data-status="forbidden"/);
    expect(islandsIn(response.body)).toContainEqual({ status: 'forbidden' });
    expect(response.body).not.toContain('"stats"');
  });

  it('concurrent pages of two users never mix their islands — each request its own scope and session copy', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => app.actingAs(index % 2 === 0 ? ada : alan).get('/dashboard', document)));
    responses.forEach((response, index) => {
      const admin = index % 2 === 0;
      expect(response.body).toMatch(admin ? /data-island="dashboard\.members" data-status="ready"/ : /data-island="dashboard\.members" data-status="forbidden"/);
      expect(response.body.includes('"stats"')).toBe(admin);
      expect(response.page()!.props).toMatchObject({ auth: { user: { name: admin ? ada.name : alan.name } } });
    });
  }, ciTimeout);

  it('sees whoever the page signed in — a remember-me sign-in of the page request itself (the cookie does not know it yet)', async () => {
    const login = await app.post('/login', { form: { email: ada.email, password: 'password', remember: 'on' } }).assertRedirect();
    // A new browser session: only the remember-me cookie. The page signs Ada in; its islands see her — and rotate nothing.
    const browser = app.withCookie('remember_web', login.cookie('remember_web')!);
    const response = await browser.get('/dashboard', document).assertOk().assertServerRendered();
    expect(response.body).toMatch(/data-island="dashboard\.members" data-status="ready"/);
    // The page's own rotated token is still good: the islands did not use (and so "steal") the old one.
    const next = app.withCookie('remember_web', response.cookie('remember_web')!);
    await next.get('/dashboard', document).assertOk().assertAuthenticated(ada);
  });
});
