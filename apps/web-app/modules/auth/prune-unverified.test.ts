import { AccessTokenStore, PasswordResetTokenStore } from '@marmeon/auth';
import { Connections, sql } from '@marmeon/database';
import { Notifications } from '@marmeon/notifications';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ProfileLinkFactory } from '../user-profile/factories/ProfileLinkFactory.ts';
import { AccountDeletion } from './AccountDeletion.ts';
import { PruneUnverifiedCommand } from './commands/PruneUnverifiedCommand.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { NewSignInNotification } from './index.ts';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

// The web app's prune of accounts whose address was never confirmed (the same command as make:auth's): the row and what the
// other modules keep for it (AccountDeleted) — its avatar file, its data export, its notifications, its profile links and
// sign-in activity (cascade) — and its rows in the sessions table. Nightly at 03:20 Berlin time (schedule.test.ts) — this app
// turns it on (the module make:auth writes has the line commented out).

const DAY = 86_400_000;

describe('pruning accounts whose address was never confirmed', () => {
  let app: TestApp;
  /** An account made `days` ago (nothing changed since). */
  const made = (days: number, confirmed: boolean, email: string, avatar: string | null = null) => {
    const at = new Date(app.clock.now() - days * DAY).toISOString();
    const confirmedAt = confirmed ? at : null;
    return app.factory(UserFactory).create({ email, avatar_path: avatar, created_at: at, updated_at: at, email_verified_at: confirmedAt, first_verified_at: confirmedAt }) as Promise<User>;
  };
  const sessions = async () =>
    (await sql<{ user_id: string | null }>`select user_id from sessions order by user_id`.execute(app.make(Connections).get())).rows.map((row) => row.user_id);
  const count = async (table: string, user: User) =>
    Number((await sql<{ n: number | string }>`select count(*) as n from ${sql.table(table)} where user_id = ${user.id}`.execute(app.make(Connections).get())).rows[0]!.n);
  const notifications = async (user: User) =>
    Number(
      (await sql<{ n: number | string }>`select count(*) as n from notifications where recipient_type = 'user' and recipient_id = ${String(user.id)}`.execute(app.make(Connections).get()))
        .rows[0]!.n,
    );

  it('deletes the account with everything that is its — and only that: a confirmed account keeps all of its', async () => {
    app = await createTestApp(application, { database: 'refresh', notifications: 'real', env: { SESSION_DRIVER: 'database' } });
    app.freeze();
    const old = await made(8, false, 'old@example.com', 'avatars/old.png');
    const kept = await made(30, true, 'kept@example.com', 'avatars/kept.png');
    const young = await made(5, false, 'young@example.com');
    // Confirmed once, long ago — its new address (AUTH_PRIVATE_REGISTRATION=false) is unconfirmed: it stays all the same.
    const longAgo = new Date(app.clock.now() - 400 * DAY).toISOString();
    const onceConfirmed = (await app.factory(UserFactory).create({ email: 'once@example.com', created_at: longAgo, updated_at: longAgo, email_verified_at: null, first_verified_at: longAgo })) as User;
    // Confirmed by code that knows only email_verified_at (an admin tool, an old seeder): confirmed is confirmed.
    const legacy = (await app.factory(UserFactory).create({ email: 'legacy@example.com', created_at: longAgo, updated_at: longAgo, email_verified_at: longAgo, first_verified_at: null })) as User;
    // Never confirmed, changed 3 days ago: the days count from the sign-up — a change does not extend them.
    const touched = (await app.factory(UserFactory).create({ email: 'touched@example.com', created_at: new Date(app.clock.now() - 40 * DAY).toISOString(), updated_at: new Date(app.clock.now() - 3 * DAY).toISOString(), email_verified_at: null, first_verified_at: null })) as User;
    const disk = app.storage.disk('public');
    for (const user of [old, kept]) {
      // Signed in (a row in sessions with its user_id), "remember me", an API token, an avatar, a link, a notification.
      await app.post('/login', { form: { email: user.email, password: 'password', remember: 'on' } }).assertRedirect();
      await app.make(AccessTokenStore).create(user.id, 'cli', { expiresIn: '365d' });
      await app.make(PasswordResetTokenStore).create(user.email, 0);
      await disk.put(user.avatar_path!, new Uint8Array([137, 80, 78, 71]));
      await app.factory(ProfileLinkFactory).create({ user_id: user.id });
      await app.make(Notifications).sendNow({ type: 'user', id: user.id }, NewSignInNotification, { at: new Date().toISOString(), ip: null, agent: null });
    }
    expect(await sessions()).toEqual([String(old.id), String(kept.id)].sort());
    expect(await notifications(old)).toBe(1);
    expect(await count('remember_tokens', old)).toBe(1);

    const results = await app.schedule.run(nightAfter(app.clock.now()));
    expect(results.find((result) => result.task === 'auth:prune-unverified')).toMatchObject({ outcome: 'ran' });

    expect(await app.make(UserRepository).find(old.id), 'an account unconfirmed for 8 days was kept').toBeUndefined();
    expect(await app.make(UserRepository).find(kept.id), 'a confirmed account was deleted').toBeDefined();
    expect(await app.make(UserRepository).find(young.id), 'an account unconfirmed for 5 days was deleted').toBeDefined();
    expect(await app.make(UserRepository).find(onceConfirmed.id), 'an account confirmed once was deleted').toBeDefined();
    expect(await app.make(UserRepository).find(legacy.id), 'a confirmed account without first_verified_at was deleted').toBeDefined();
    expect(await app.make(UserRepository).find(touched.id), 'a never confirmed account of 40 days was kept: an update extended its days').toBeUndefined();
    expect(await sessions(), 'the deleted account kept its sessions').toEqual([String(kept.id)]);
    const resets = await sql<{ email: string }>`select email from password_reset_tokens`.execute(app.make(Connections).get());
    expect(resets.rows.map((row) => row.email), 'the deleted account kept its reset token').toEqual([kept.email]);
    disk.assertMissing('avatars/old.png').assertExists('avatars/kept.png');
    expect([await notifications(old), await notifications(kept)]).toEqual([0, 1]);
    for (const table of ['remember_tokens', 'personal_access_tokens', 'profile_links', 'login_activity']) {
      expect([table, await count(table, old), await count(table, kept)]).toEqual([table, 0, 1]);
    }
  });

  it('a deleted account\'s data export goes too — after the commit; another account\'s stays', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    app.freeze();
    const old = await made(8, false, 'old@example.com');
    const kept = await made(30, true, 'kept@example.com');
    const local = app.storage.disk('local');
    // "Download my data" left its export on the private disk — its address, name and links.
    for (const user of [old, kept]) await local.put(`exports/user-${user.id}.json`, JSON.stringify({ account: { email: user.email } }));
    expect(await app.make(AccountDeletion).delete([old.id], { unconfirmedSince: new Date(app.clock.now() - 7 * DAY) })).toHaveLength(1);
    local.assertMissing(`exports/user-${old.id}.json`).assertExists(`exports/user-${kept.id}.json`);
  });

  it('decides again when it deletes: an account confirmed between the look-up and the delete stays', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    app.freeze();
    const old = await made(8, false, 'old@example.com');
    const since = new Date(app.clock.now() - 7 * DAY);
    expect(await app.make(UserRepository).unconfirmedSince(since, 100)).toEqual([old.id]);
    await sql`update users set email_verified_at = ${new Date(app.clock.now()).toISOString()} where id = ${old.id}`.execute(app.make(Connections).get());
    expect(await app.make(AccountDeletion).delete([old.id], { unconfirmedSince: since }), 'an account confirmed meanwhile was deleted').toEqual([]);
    expect(await app.make(UserRepository).find(old.id)).toBeDefined();
  });

  it('the first confirmation is kept for good: confirmed, then changed to an unconfirmed address — never pruned', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    app.freeze();
    const kj = await made(30, false, 'kj@example.com');
    await app.make(UserRepository).markEmailVerified(kj.id);
    // AUTH_PRIVATE_REGISTRATION=false: a new address at once, unconfirmed.
    expect(await app.make(UserRepository).changeEmail(kj.id, 'katherine@nasa.example')).toMatchObject({ email_verified_at: null });
    const first = (await app.make(UserRepository).find(kj.id))?.first_verified_at;
    expect(first, 'the first confirmation was not kept').not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.make(UserRepository).markEmailVerified(kj.id); // a second confirmation keeps the first's time
    expect((await app.make(UserRepository).find(kj.id))?.first_verified_at).toEqual(first);
    await app.make(UserRepository).changeEmail(kj.id, 'kj@nasa.example');
    app.travel({ days: 30 });
    expect(await app.make(UserRepository).unconfirmedSince(new Date(app.clock.now() - 7 * DAY), 100)).toEqual([]);
    expect(await app.make(AccountDeletion).delete([kj.id], { unconfirmedSince: new Date(app.clock.now() - 7 * DAY) })).toEqual([]);
    expect(await app.make(UserRepository).find(kj.id), 'an account confirmed once was deleted').toBeDefined();
  });

  it('the verification link records the first confirmation itself — whatever clears the address later', async () => {
    // changeEmail() keeps a confirmation too (coalesce) and so hides a link that records none in the test above — here the
    // link's own write, before anything else touches the account.
    app = await createTestApp(application, { database: 'refresh' });
    app.freeze();
    const kj = await made(30, false, 'kj@example.com');
    await app.make(UserRepository).markEmailVerified(kj.id);
    const confirmed = await app.make(UserRepository).find(kj.id);
    expect(confirmed?.first_verified_at, 'the link did not record the first confirmation').not.toBeNull();
    expect(confirmed?.first_verified_at).toEqual(confirmed?.email_verified_at);
  });

  it('an account confirmed by email_verified_at alone (an import, a seeder) keeps that through a change of address (open mode)', async () => {
    app = await createTestApp(application, { database: 'refresh', env: { AUTH_PRIVATE_REGISTRATION: 'false' } });
    app.freeze();
    const longAgo = new Date(app.clock.now() - 400 * DAY).toISOString();
    const legacy = (await app.factory(UserFactory).create({ email: 'legacy@example.com', created_at: longAgo, updated_at: longAgo, email_verified_at: longAgo, first_verified_at: null })) as User;
    expect(await app.make(UserRepository).changeEmail(legacy.id, 'legacy@new.example')).toMatchObject({ email_verified_at: null });
    expect((await app.make(UserRepository).find(legacy.id))?.first_verified_at, 'the change dropped the only confirmation').not.toBeNull();
    app.travel({ days: 30 });
    await app.schedule.run(nightAfter(app.clock.now()));
    expect(await app.make(UserRepository).find(legacy.id), 'a confirmed account was deleted after its address changed').toBeDefined();
  });

  it('a deletion that fails keeps everything — the avatar too (it goes after the commit only)', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    app.freeze();
    const old = await made(8, false, 'old@example.com', 'avatars/old.png');
    const disk = app.storage.disk('public');
    await disk.put('avatars/old.png', new Uint8Array([1]));
    // A module's listener that fails (here: the notifications table is gone) rolls the whole deletion back.
    await sql`drop table notifications`.execute(app.make(Connections).get());
    await expect(app.make(PruneUnverifiedCommand).handle({ options: {}, args: [], output: { success: () => {}, error: () => {} } } as never)).rejects.toThrow();
    expect(await app.make(UserRepository).find(old.id)).toBeDefined();
    disk.assertExists('avatars/old.png');
  });
});

/** 03:20 in Berlin, the night after `now` — when the schedule runs the prune. */
function nightAfter(now: number): string {
  const day = Temporal.Instant.fromEpochMilliseconds(now + DAY).toZonedDateTimeISO('Europe/Berlin').toPlainDate();
  return day.toZonedDateTime({ timeZone: 'Europe/Berlin', plainTime: '03:20' }).toString();
}
