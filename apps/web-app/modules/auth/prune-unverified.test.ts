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

// The web app's prune of accounts whose address was never confirmed (E203, the same command as make:auth's): the row and what
// the other modules keep for it (AccountDeleted) — its avatar file, its notifications, its profile links and sign-in activity
// (cascade) — and its rows in the sessions table. Nightly at 03:20 Berlin time (schedule.test.ts).

const DAY = 86_400_000;

describe('pruning accounts whose address was never confirmed (E203)', () => {
  let app: TestApp;
  /** An account made `days` ago (nothing changed since). */
  const made = (days: number, confirmed: boolean, email: string, avatar: string | null = null) => {
    const at = new Date(app.clock.now() - days * DAY).toISOString();
    return app.factory(UserFactory).create({ email, avatar_path: avatar, created_at: at, updated_at: at, email_verified_at: confirmed ? at : null }) as Promise<User>;
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
    // Made long ago, changed (unconfirmed) 3 days ago: its days count from the change.
    const changedAt = new Date(app.clock.now() - 3 * DAY).toISOString();
    const changed = (await app.factory(UserFactory).create({ email: 'changed@example.com', created_at: new Date(app.clock.now() - 40 * DAY).toISOString(), updated_at: changedAt, email_verified_at: null })) as User;
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
    expect(await app.make(UserRepository).find(changed.id), 'an account changed 3 days ago was deleted').toBeDefined();
    expect(await sessions(), 'the deleted account kept its sessions').toEqual([String(kept.id)]);
    const resets = await sql<{ email: string }>`select email from password_reset_tokens`.execute(app.make(Connections).get());
    expect(resets.rows.map((row) => row.email), 'the deleted account kept its reset token').toEqual([kept.email]);
    disk.assertMissing('avatars/old.png').assertExists('avatars/kept.png');
    expect([await notifications(old), await notifications(kept)]).toEqual([0, 1]);
    for (const table of ['remember_tokens', 'personal_access_tokens', 'profile_links', 'login_activity']) {
      expect([table, await count(table, old), await count(table, kept)]).toEqual([table, 0, 1]);
    }
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
