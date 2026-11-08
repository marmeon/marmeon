import { Connections, sql } from '@marmeon/database';
import { notificationsChannel } from '@marmeon/live';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { NewSignInNotification } from '../auth/index.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import type { User } from '../auth/users.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// The tests run on memory (.env.test); this one shows the driver a new app ships: the hints travel through the live_hints
// table. `isolated` commits for real (a hint goes out after its commit), on the worker's own database file.
const env = { LIVE_DRIVER: 'database', LIVE_POLL_MILLISECONDS: '50' };

const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:142.0) Gecko/20100101 Firefox/142.0';
const channelOf = (user: User) => notificationsChannel({ type: 'user', id: user.id });

const hintRows = async (app: TestApp) =>
  (await sql<{ id: number | string; channel: string | null; message: string }>`select id, channel, message from live_hints order by id`.execute(app.make(Connections).get())).rows;

describe('LIVE_DRIVER=database in the web app', () => {
  it('a notification sent by a queue worker reaches the open bell through the live_hints table, and so does a hint another process writes', async () => {
    await using app = await createTestApp(application, { database: 'isolated', env });
    const ada = await app.factory(UserFactory).create({ locale: 'en' });
    const tab = await app.actingAs(ada).live('/notifications');
    await tab.hello();

    // A sign-in queues the SignedIn listener; the worker's run notifies Ada.
    await app.post('/login', { form: { email: ada.email, password: 'password' }, headers: { 'user-agent': FIREFOX } }).assertRedirect('/users/me');
    await app.queue.work();
    app.notifications.assertSent({ type: 'user', id: ada.id }, NewSignInNotification);
    await app.notifications.deliver();
    await tab.waitFor(1);

    const rows = await hintRows(app);
    const mine = rows.filter((row) => row.channel === channelOf(ada));
    expect(mine).toHaveLength(1);
    expect(tab.hints).toEqual([{ channel: channelOf(ada), only: null, seq: Number(mine[0]!.id) }]); // the number of a channel is its row id

    // Another process (a worker on this machine) inserts a hint: only the poll can bring it to this tab.
    await sql`insert into live_hints (channel, message, created_at) values (${channelOf(ada)}, ${JSON.stringify({ v: 1, kind: 'refresh', channel: channelOf(ada), only: ['unread'] })}, ${Date.now()})`.execute(app.make(Connections).get());
    await tab.waitFor(2);
    expect(tab.hints[1]).toMatchObject({ channel: channelOf(ada), only: ['unread'] });
    expect(tab.hints[1]!.seq).toBeGreaterThan(tab.hints[0]!.seq);
  });

  it('signing out closes the streams of the session — through the table, not the process', async () => {
    await using app = await createTestApp(application, { database: 'isolated', env });
    const ada = await app.factory(UserFactory).create();
    const view = app.actingAs(ada);
    const tab = await view.live('/notifications');
    await tab.hello();
    await view.post('/logout', { json: {} }).assertRedirect();
    await tab.closed;
    expect(tab.events.map((each) => each.event)).toEqual(['hello', 'end']);
    const ends = (await hintRows(app)).filter((row) => row.channel === null);
    expect(ends).toHaveLength(1);
    expect(JSON.parse(ends[0]!.message)).toMatchObject({ v: 1, kind: 'end' });
  });
});
