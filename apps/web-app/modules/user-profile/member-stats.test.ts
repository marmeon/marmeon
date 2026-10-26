import { Registered } from '@marmeon/auth';
import { EventRegistry } from '@marmeon/core';
import { createTestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { RebuildMemberStatsJob } from './jobs/RebuildMemberStatsJob.ts';
import { MemberStats } from './MemberStats.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

const post = (app: Awaited<ReturnType<typeof createTestApp>>, email: string) =>
  app.post('/register', { form: { name: 'New Member', email, password: 'orbital mechanics', password_confirmation: 'orbital mechanics' } });
const register = (app: Awaited<ReturnType<typeof createTestApp>>, email: string) => post(app, email).assertRedirect('/register/sent');

// The dashboard's member numbers as a snapshot, rebuilt by a unique job after registrations.
describe('the member numbers snapshot', () => {
  it('a burst of registrations queues ONE rebuild (unique) — and the snapshot follows once it ran', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const stats = app.make(MemberStats);
    const before = (await stats.current()).members;

    await register(app, 'one@example.com');
    await register(app, 'two@example.com');
    await register(app, 'three@example.com');
    app.queue.assertDispatchedTimes(RebuildMemberStatsJob, 1).assertDispatched(RebuildMemberStatsJob, undefined, { unique: 'members' });
    expect(app.queue.dispatched(RebuildMemberStatsJob)[0]!.unique).toEqual({ key: 'members', forSeconds: 600, until: 'processing' });
    // Until the job ran, the island reads the snapshot (no count per request).
    expect((await stats.current()).members).toBe(before);

    await app.queue.work();
    expect((await stats.current()).members).toBe(before + 3);
    // The key is free again: the next registration queues the next rebuild.
    await register(app, 'four@example.com');
    app.queue.assertDispatchedTimes(RebuildMemberStatsJob, 2);
  });

  it('a registration that rolls back frees the key again — the next one queues its rebuild', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    // A listener after ours throws: the registration's transaction rolls back — the rebuild's row with it, its key freed.
    let fail = true;
    app.make(EventRegistry).listen(Registered, () => {
      if (fail) throw new Error('a listener failed');
    });
    await post(app, 'a@example.com').assertStatus(500);
    app.queue.assertNotDispatched(RebuildMemberStatsJob);
    fail = false;
    await register(app, 'b@example.com');
    app.queue.assertDispatchedTimes(RebuildMemberStatsJob, 1);
  });
});
