import { AccessTokenStore, PASSWORD_RESET_TABLE, PasswordResetTokenStore, REMEMBER_TABLE, RememberTokenStore } from '@bespokecore/auth';
import { Connections } from '@bespokecore/database';
import { SessionLottery } from '@bespokecore/session';
import { createTestApp } from '@bespokecore/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { RebuildMemberStatsJob } from '../user-profile/jobs/RebuildMemberStatsJob.ts';
import { UserFactory } from './factories/UserFactory.ts';

// The web app's schedule (W6 step 6, E88): the nightly token prune (finding 5 — expired API tokens were never deleted),
// the housekeeping of modules/system and the hourly member numbers — with the test clock (E97).
describe('the schedule', () => {
  it('prunes expired reset, remember-me and API tokens at 03:10 Berlin time — valid ones stay', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const alan = await app.factory(UserFactory).create({ email: 'alan@example.com' });
    app.freeze(Date.parse('2026-10-04T12:00:00Z'));
    // Yesterday: tokens that expire long before tonight.
    await app.make(PasswordResetTokenStore).create(ada!.email, 0);
    await app.make(RememberTokenStore).create(ada!.id, new Date(app.clock.now() + 3_600_000));
    const expired = await app.make(AccessTokenStore).create(ada!.id, 'one hour', { expiresIn: '1h' });
    // Tonight, shortly before the prune: valid ones.
    app.travelTo(Date.parse('2026-10-05T00:50:00Z'));
    await app.make(PasswordResetTokenStore).create(alan!.email, 0);
    await app.make(RememberTokenStore).create(alan!.id, new Date(app.clock.now() + 30 * 86_400_000));
    const valid = await app.make(AccessTokenStore).create(alan!.id, 'a year', { expiresIn: '365d' });

    expect(app.schedule.due('2026-10-05T03:10:00+02:00')).toEqual(['auth:prune-tokens']);
    expect(app.schedule.due('2026-10-05T03:10:00Z')).toEqual([]); // 05:10 in Berlin
    const results = await app.schedule.run('2026-10-05T03:10:00+02:00');
    expect(results.map((result) => [result.task, result.outcome])).toEqual([['auth:prune-tokens', 'ran']]);

    const db = app.make(Connections).get<any>();
    expect((await db.selectFrom(PASSWORD_RESET_TABLE).select('email').execute()).map((row) => row.email)).toEqual([alan!.email]);
    expect((await db.selectFrom(REMEMBER_TABLE).select('user_id').execute()).map((row) => Number(row.user_id))).toEqual([alan!.id]);
    expect((await app.make(AccessTokenStore).list(ada!.id)).map((token) => token.id)).toEqual([]);
    expect((await app.make(AccessTokenStore).list(alan!.id)).map((token) => token.id)).toEqual([valid.token.id]);
    expect(await app.make(AccessTokenStore).find(expired.plainText)).toBeUndefined();
  });

  it('keeps the tables of modules/system tidy — and the requests draw no session lottery', async () => {
    const app = await createTestApp(application);
    expect(app.schedule.tasks).toEqual(['auth:prune-tokens', 'user-profile.rebuild-member-stats', 'session:prune', 'cache:prune', 'queue:prune-failed --hours=168']);
    expect(app.schedule.due('2026-10-05T03:15:00+02:00')).toEqual(['session:prune']);
    expect(app.schedule.due('2026-10-05T03:20:00+02:00')).toEqual(['queue:prune-failed --hours=168']);
    expect(app.schedule.due('2026-10-05T10:25:00Z')).toEqual(['cache:prune']);
    expect(app.make(SessionLottery).chance).toBe(0);
  });

  it('queues the member numbers hourly — one waiting job while the workers are behind', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    app.freeze(Date.parse('2026-10-05T09:59:00Z')); // to the millisecond: the lock of 10:00 would end at 11:00 sharp
    await app.schedule.run('2026-10-05T10:00:00Z');
    await app.schedule.run('2026-10-05T11:00:00Z');
    app.queue.assertDispatchedTimes(RebuildMemberStatsJob, 1);
    await app.queue.work();
    await app.schedule.run('2026-10-05T12:00:00Z');
    app.queue.assertDispatchedTimes(RebuildMemberStatsJob, 2);
  });
});
