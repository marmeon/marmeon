import { UserFactory, UserRepository, type User } from '#modules/auth';
import { notificationsChannel } from '@bespokecore/live';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

const profile = (user: User) => `/users/${user.id}`;
/** A tab of `user` — its requests name its document (x-bespoke-connection), as the client core's do. */
const tab = (user: User, connection: string) => app.actingAs(user).withHeaders({ 'x-bespoke-connection': connection });

describe('live props in the web app (W6.10)', () => {
  it('the profile follows users.<id> (profile, activity) and the bell its notifications — signed for the session', async () => {
    const page = (await app.actingAs(ada).navigating().get(profile(ada)).assertOk()).page()!;
    expect(page.live).toEqual([
      { channel: notificationsChannel({ type: 'user', id: ada.id }), only: ['bell'], token: expect.any(String) },
      { channel: `users.${ada.id}`, only: ['profile', 'activity'], token: expect.any(String) },
    ]);
    // A guest's page (the login) follows nothing: the shared channel is the signed-in user's.
    expect((await app.navigating().get('/login').assertOk()).page()!.live).toBeUndefined();
  });

  it('a link added in tab A: tab B gets one hint for its profile — tab A, which sent it, nothing to reload', async () => {
    const tabA = await app.actingAs(ada).live(profile(ada), { connection: 'tab-a-ada-0001' });
    const tabB = await app.actingAs(ada).live(profile(ada), { connection: 'tab-b-ada-0001' });
    await Promise.all([tabA.hello(), tabB.hello()]);
    await tab(ada, 'tab-a-ada-0001').post(`${profile(ada)}/links`, { json: { label: 'Blog', url: 'https://ada.example' } }).assertRedirect(profile(ada));
    await Promise.all([tabA.waitFor(1), tabB.waitFor(1)]);
    expect(tabB.hints).toEqual([{ channel: `users.${ada.id}`, only: ['profile'], seq: 1 }]);
    expect(tabA.hints).toEqual([{ channel: `users.${ada.id}`, only: [], seq: 1 }]);
    app.broadcast.assertRefreshed(`users.${ada.id}`, { only: ['profile'], times: 1 });
    // What tab B then asks for — the partial reload the hint leads to — has the new link.
    await app
      .actingAs(ada)
      .reloading<ShowUserProfileController>('user-profile/Show', { only: ['profile'] })
      .get(profile(ada))
      .assertPage<ShowUserProfileController>('user-profile/Show', (props) => expect(props.profile.links.map((link) => link.label)).toContain('Blog'));
  });

  it('removing a link, saving the profile or the picture hints the profile too; another user’s profile hears nothing', async () => {
    const link = await app.factory(ProfileLinkFactory).create({ user_id: alan.id });
    const alans = await app.actingAs(ada).live(profile(alan));
    const adas = await app.actingAs(ada).live(profile(ada));
    await Promise.all([alans.hello(), adas.hello()]);
    await app.actingAs(alan).delete(`${profile(alan)}/links/${link.id}`).assertRedirect(profile(alan));
    await app.actingAs(alan).put(profile(alan), { json: { name: 'Alan M. Turing', bio: '' } }).assertRedirect(profile(alan));
    await alans.waitFor(2);
    expect(alans.hints.map((hint) => hint.channel)).toEqual([`users.${alan.id}`, `users.${alan.id}`]);
    expect(adas.hints).toEqual([]);
  });

  it('someone signs in: the "Recent sign-ins" island on Ada’s dashboard hears it', async () => {
    const ada$ = app.actingAs(ada); // one browser: the island's token is for its session
    const island = (await ada$.island('dashboard.sign-ins').assertOk()).json() as { live?: { channel: string; token: string }[] };
    expect(island.live).toEqual([{ channel: 'dashboard.sign-ins', token: expect.any(String) }]);
    const dashboard = await ada$.live(island.live!);
    await dashboard.hello();
    await app.post('/login', { form: { email: alan.email, password: 'password' } }).assertRedirect('/users/me');
    await dashboard.waitFor(1);
    expect(dashboard.hints).toEqual([{ channel: 'dashboard.sign-ins', only: null, seq: 1 }]);
  });

  it('a new sign-in notification: once delivered (its row committed), the bell’s channel hears it — no polling', async () => {
    const page = await app.actingAs(ada).live(profile(ada));
    await page.hello();
    await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect('/users/me');
    await app.queue.work();
    expect(page.hints).toEqual([]); // sent, not delivered yet (the fake records)
    await app.notifications.deliver();
    await page.waitFor(1);
    expect(page.hints).toEqual([{ channel: notificationsChannel({ type: 'user', id: ada.id }), only: null, seq: 1 }]);
    // Read in another tab: this tab's bell hears it too.
    const [row] = ((await app.actingAs(ada).navigating().get('/notifications').assertOk()).page()!.props.notifications as { data: { id: string }[] }).data;
    await tab(ada, 'tab-other-0001').acting().post(`/notifications/${row!.id}/read`).assertOk();
    await page.waitFor(2);
  });

  it('a token rewritten from Ada’s profile to Alan’s opens no stream (403) — the channel is signed, not just named', async () => {
    const ada$ = app.actingAs(ada); // one browser, one session
    const live = (await ada$.navigating().get(profile(ada))).page()!.live!;
    const forged = live.map((subscription) => (subscription.channel === `users.${ada.id}` ? { ...subscription, channel: `users.${alan.id}` } : subscription));
    expect((await ada$.live(forged)).status).toBe(403);
    // Alan's session cannot use Ada's tokens either — nor can Ada's other browser (another session).
    expect((await app.actingAs(alan).live(live)).status).toBe(403);
    expect((await app.actingAs(ada).live(live)).status).toBe(403);
    // The tokens as they were signed: a stream.
    const stream = await ada$.live(live);
    expect(stream.status).toBe(200);
  });

  it('one browser keeps 16 tabs connected; the 17th is refused (429) — another user’s tab still connects, and a hint still arrives (W9 step 4)', async () => {
    const ada$ = app.actingAs(ada); // one browser — one session
    const live = (await ada$.navigating().get(profile(ada))).page()!.live!;
    const tabs = [];
    for (let n = 0; n < 16; n++) tabs.push(await ada$.live(live, { connection: `tab-${String(n).padStart(2, '0')}-ada-0001` }));
    expect(tabs.map((stream) => stream.status)).toEqual(Array(16).fill(200));
    expect((await ada$.live(live, { connection: 'tab-16-ada-0001' })).status).toBe(429);
    const alans = await app.actingAs(alan).live(profile(ada));
    expect(alans.status).toBe(200);
    await Promise.all([...tabs, alans].map((stream) => stream.hello()));
    await app.actingAs(ada).post(`${profile(ada)}/links`, { json: { label: 'Blog', url: 'https://ada.example' } }).assertRedirect(profile(ada));
    await Promise.all([tabs[15]!.waitFor(1), alans.waitFor(1)]);
  });

  it('signing out in tab A closes tab B’s stream (`end`) — no further hints', async () => {
    const ada$ = app.actingAs(ada); // both tabs in one browser — one session
    const tabB = await ada$.live(profile(ada), { connection: 'tab-b-ada-0001' });
    await tabB.hello();
    await ada$.withHeaders({ 'x-bespoke-connection': 'tab-a-ada-0001' }).post('/logout').assertRedirect('/login');
    await tabB.closed;
    expect(tabB.events.map((each) => each.event)).toEqual(['hello', 'end']);
    await app.actingAs(ada).post(`${profile(ada)}/links`, { json: { label: 'After', url: 'https://after.example' } });
    expect(tabB.hints).toEqual([]);
  });

  it('a user signing in elsewhere does not close Ada’s streams', async () => {
    const stream = await app.actingAs(ada).live(profile(ada));
    await stream.hello();
    const grace = await app.factory(UserFactory).create();
    await app.post('/login', { form: { email: grace.email, password: 'password' } }).assertRedirect('/users/me');
    await app.actingAs(alan).post(`${profile(ada)}/links`, { json: { label: 'x', url: 'https://x.example' } }).assertForbidden();
    await app.actingAs(ada).post(`${profile(ada)}/links`, { json: { label: 'Mine', url: 'https://mine.example' } });
    await stream.waitFor(1);
    expect(stream.ended).toBe(false);
  });
});
