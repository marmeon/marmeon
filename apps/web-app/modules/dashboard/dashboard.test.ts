import { UserFactory, UserRepository, type User } from '#modules/auth';
import { authenticate } from '@bespokecore/auth';
import { defineModule } from '@bespokecore/core';
import { AfterResponse, Controller, defineRoutes } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ProfileDirectory } from '../user-profile/ProfileDirectory.ts';
import { LoginActivityRepository } from '../user-profile/LoginActivityRepository.ts';
import type { ShowMemberStatsController } from './controllers/ShowMemberStatsController.ts';
import type { ShowRecentSignInsController } from './controllers/ShowRecentSignInsController.ts';

/** An island that writes the session — what E52 forbids. */
class WritesSessionIsland extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.put('island_wrote', true);
    return this.island('dashboard/RecentSignIns', { entries: [], now: new Date() });
  }
}

/** An island that flashes (a redirect with data) — a write too. */
class FlashesIsland extends Controller {
  handle() {
    return this.redirect('/dashboard').flash('toast', { kind: 'info', message: 'from an island' });
  }
}

/** An island that defers work after the response. */
class DefersIsland extends Controller {
  readonly #after: AfterResponse;
  constructor(after: AfterResponse) {
    super();
    this.#after = after;
  }
  handle() {
    this.#after.defer(() => undefined);
    return this.island('dashboard/RecentSignIns', { entries: [], now: new Date() });
  }
}

/** A page action that flashes a message for the page it redirects to. */
class SaveController extends Controller {
  handle() {
    return this.redirect('/dashboard').flash('toast', { kind: 'success', message: 'Saved.' });
  }
}

const fixtures = defineModule({
  name: 'island-fixtures',
  routes: defineRoutes((Route) => {
    const signedIn = Route.middleware(authenticate());
    signedIn.get('/fixtures/islands/writes-session', WritesSessionIsland);
    signedIn.get('/fixtures/islands/flashes', FlashesIsland);
    signedIn.get('/fixtures/islands/defers', DefersIsland);
    signedIn.post('/fixtures/save', SaveController);
  }),
});

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(
    { ...application, modules: [...application.modules!, fixtures] },
    { database: 'refresh', seed: true, env: { DASHBOARD_ADMINS: 'ada@example.com, kj@example.com' } },
  );
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

describe('the dashboard: a page of islands (E48)', () => {
  it('is a page that loads nothing itself — each panel is an island route', async () => {
    await app.actingAs(ada).navigating().get('/dashboard').assertOk().assertPage('dashboard/Show', {});
  });

  it('answers an island with its region object: its own props (no shared ones), its query — no-store, no cookie', async () => {
    const activity = app.make(LoginActivityRepository);
    await activity.record(alan.id, new Date(Date.now() - 2 * 86_400_000));
    await activity.record(ada.id, new Date(Date.now() - 60 * 86_400_000));
    const response = await app
      .actingAs(ada)
      .island('dashboard.sign-ins', {}, { range: '7d' })
      .assertOk()
      .assertIsland<ShowRecentSignInsController>('dashboard/RecentSignIns', { entries: [{ id: alan.id, name: 'Alan Turing' }] });
    const region = response.island()!;
    expect(Object.keys(region.props).sort()).toEqual(['entries', 'now']);
    expect(region).not.toHaveProperty('locale');
    expect([region.query, region.queryDefaults]).toEqual([{ range: '7d' }, { range: '30d', limit: 5 }]);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.getSetCookie()).toEqual([]);
    // All time: both, newest first — an invalid limit falls back to its default (E56).
    await app
      .actingAs(ada)
      .island('dashboard.sign-ins', {}, { range: 'all' })
      .assertIsland<ShowRecentSignInsController>('dashboard/RecentSignIns', (props) => expect(props.entries.map((entry) => entry.name)).toEqual(['Alan Turing', 'Ada Lovelace']));
    await app.actingAs(ada).islanding().get('/dashboard/islands/sign-ins?limit=999').assertIsland('dashboard/RecentSignIns');
  });

  it('counter-check: a direct hit is a 404 — the browser never shows an island as a page (E52)', async () => {
    await app.actingAs(ada).get('/dashboard/islands/sign-ins', { headers: { accept: 'text/html' } }).assertNotFound();
    await app.actingAs(ada).navigating().get('/dashboard/islands/sign-ins').assertNotFound();
    await app.actingAs(ada).prefetching().get('/dashboard/islands/sign-ins').assertNotFound();
  });

  it('counter-check: a guest’s island is `unauthorized` (204) — no redirect to the login, nothing remembered for after it', async () => {
    const response = await app.island('dashboard.sign-ins').assertStatus(204).assertIslandStatus('unauthorized');
    expect(response.headers.get('location')).toBeNull();
    // The session is not written at all (no cookie): no "intended" URL that would send the user to an island after login.
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('counter-check: the island’s own authorization holds — not an administrator: `forbidden`, and no number of it reaches the browser', async () => {
    const response = await app.actingAs(alan).island('dashboard.members').assertStatus(204).assertIslandStatus('forbidden');
    expect(response.body).toBe('');
    await app.actingAs(ada).island('dashboard.members').assertIsland<ShowMemberStatsController>('dashboard/MemberStats', { stats: { members: 3, verified: 3 } });
    // Its route's middleware too: an unverified administrator is redirected by verified() — the island's `unauthorized`.
    const unverified = await app.factory(UserFactory).state('unverified').create({ email: 'kj@example.com' });
    await app.actingAs(unverified).island('dashboard.members').assertStatus(204).assertIslandStatus('unauthorized');
  });

  it('counter-check: a failing island is its own `exception` — the page answers as always', async () => {
    app.container.instance(ProfileDirectory, { memberStats: () => Promise.reject(new Error('database down')) } as unknown as ProfileDirectory);
    await app.actingAs(ada).island('dashboard.members').assertStatus(500).assertIslandStatus('exception');
    await app.actingAs(ada).navigating().get('/dashboard').assertOk().assertPage('dashboard/Show');
  });

  it('counter-check: an island is read-only (E52) — writing the session, flashing or deferring work throws in development', async () => {
    const login = await app.actingAs(ada).navigating().get('/dashboard').assertOk();
    const browser = app.withCookie('bespoke_session', login.cookie('bespoke_session')!);
    const wrote = await browser.islanding().get('/fixtures/islands/writes-session').assertStatus(500).assertIslandStatus('exception');
    expect(wrote.headers.getSetCookie()).toEqual([]);
    await browser.islanding().get('/fixtures/islands/flashes').assertStatus(500).assertIslandStatus('exception');
    await browser.islanding().get('/fixtures/islands/defers').assertStatus(500).assertIslandStatus('exception');
    // Nothing of it reached the session.
    (await browser.navigating().get('/dashboard').assertOk()).assertSessionMissing('island_wrote').assertNoFlash();
    // (The message, with debug on: "session.put('island_wrote') in an island request (GET …): an island is read-only (E52) …" —
    // see packages/server/src/islands.test.ts.)
  });

  it('counter-check: an island never signs in by the remember-me cookie — the token stays for the page (not "stolen")', async () => {
    const kj = await app.factory(UserFactory).create();
    const login = await app.post('/login', { form: { email: kj.email, password: 'password', remember: 'on' } });
    // A new browser session: only the remember-me cookie. An island comes first (a poll) — for it, nobody is signed in.
    const remembered = app.withCookie('remember_web', login.cookie('remember_web')!);
    await remembered.island('dashboard.activity').assertStatus(204).assertIslandStatus('unauthorized');
    // The page then signs in with the same cookie — had the island used (rotated) the token, this one would count as stolen.
    await remembered.navigating().get('/dashboard').assertOk().assertAuthenticated(kj);
  });

  it('counter-check: islands consume no flash message — two polls between a redirect and its page leave the message for the page', async () => {
    const login = await app.actingAs(ada).navigating().get('/dashboard').assertOk();
    const browser = app.withCookie('bespoke_session', login.cookie('bespoke_session')!);
    await browser.post('/fixtures/save').assertRedirect('/dashboard');
    // Islands of the page before (a poll) answer while the redirect is followed.
    await browser.island('dashboard.activity').assertOk().assertNoFlash();
    await browser.island('dashboard.activity').assertOk().assertNoFlash();
    await browser.navigating().get('/dashboard').assertPage('dashboard/Show').assertFlash('toast', { message: 'Saved.' });
  });
});
