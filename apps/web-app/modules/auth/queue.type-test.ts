// Type guarantees of the queue — compiled by `pnpm typecheck` / `marmeon build`, never run.
import { defineModule } from '@marmeon/core';
import { Queue, withoutOverlapping, type JobContext, type JobPayload } from '@marmeon/queue';
import type { TestApp } from '@marmeon/testing';
import { rules as r } from '@marmeon/validation';
import { RebuildMemberStatsJob } from '../user-profile/jobs/RebuildMemberStatsJob.ts';
import { SendWelcomeMailJob } from './jobs/SendWelcomeMailJob.ts';

export async function Dispatching(queue: Queue) {
  const id: string = await queue.dispatch(SendWelcomeMailJob, { userId: 7 }, { delay: 60, queue: 'mail' });
  await queue.bulk([
    [SendWelcomeMailJob, { userId: 1 }],
    [SendWelcomeMailJob, { userId: 2 }],
  ]);
  // @ts-expect-error — the payload comes from static schema: userId is a number
  await queue.dispatch(SendWelcomeMailJob, { userId: 'x' });
  // @ts-expect-error — and it is required
  await queue.dispatch(SendWelcomeMailJob, {});
  // @ts-expect-error — in a bulk list as well
  await queue.bulk([[SendWelcomeMailJob, { userId: 'one' }]]);
  return id;
}

export function Payload(payload: JobPayload<typeof SendWelcomeMailJob>) {
  const userId: number = payload.userId;
  // @ts-expect-error — only what the schema describes
  return payload.email ?? userId;
}

class NoName {
  static readonly schema = r.object({});
  handle() {}
}
class NoHandle {
  static readonly job = 'auth.no-handle';
  static readonly schema = r.object({});
}
class WithDate {
  static readonly job = 'auth.with-date';
  static readonly schema = r.object({ at: r.value<Date>((value) => (value instanceof Date ? undefined : 'Not a date.')) });
  handle() {}
}

export async function NotJobs(queue: Queue) {
  // @ts-expect-error — a job needs static job (its stable name) and static schema
  await queue.dispatch(NoName, {});
  // @ts-expect-error — and handle()
  await queue.dispatch(NoHandle, {});
  // @ts-expect-error — a payload is stored as JSON: no Dates
  await queue.dispatch(WithDate, { at: new Date() });
  // @ts-expect-error — a module's jobs are job classes
  defineModule({ name: 'broken', jobs: [NoName] });
}

export function Assertions(app: TestApp) {
  app.queue.assertDispatched(SendWelcomeMailJob, { userId: 1 });
  // The payload as dispatched: r.integer() takes a number's spelling too (`'7'`) — the job gets the number.
  app.queue.assertDispatched(SendWelcomeMailJob, (payload) => Number(payload.userId) > 0);
  // @ts-expect-error — the match is a part of the payload
  app.queue.assertDispatched(SendWelcomeMailJob, { userId: 'one' });
}

// Unique jobs, chains, middleware, job.once.
export async function Unique(queue: Queue) {
  // A unique dispatch may queue nothing: its id is string | undefined.
  const maybe: string | undefined = await queue.dispatch(RebuildMemberStatsJob, {}, { unique: 'members', uniqueFor: { minutes: 10 }, uniqueUntil: 'processing' });
  // @ts-expect-error — so it is not a plain string
  const id: string = await queue.dispatch(RebuildMemberStatsJob, {}, { unique: 'members' });
  // @ts-expect-error — uniqueUntil is 'processing' or 'done'
  await queue.dispatch(RebuildMemberStatsJob, {}, { unique: 'members', uniqueUntil: 'started' });
  // @ts-expect-error — bulk() queues no unique jobs
  await queue.bulk([[RebuildMemberStatsJob, {}]], { unique: 'members' });
  // @ts-expect-error — the payload is still checked with a unique key
  await queue.dispatch(SendWelcomeMailJob, { userId: 'one' }, { unique: 'welcome' });
  return [maybe, id];
}

export async function Chains(queue: Queue) {
  const ids: string[] = await queue.chain([
    [SendWelcomeMailJob, { userId: 1 }],
    [RebuildMemberStatsJob, {}],
  ]);
  // @ts-expect-error — every payload of a chain is checked against its job's schema
  await queue.chain([[SendWelcomeMailJob, { userId: 1 }], [SendWelcomeMailJob, { userId: 'x' }]]);
  // @ts-expect-error — chain() takes no unique key
  await queue.chain([[RebuildMemberStatsJob, {}]], { unique: 'members' });
  return ids;
}

const ByUser = r.object({ userId: r.integer() });
export class TypedMiddlewareJob {
  static readonly job = 'auth.typed-middleware';
  static readonly schema = ByUser;
  // The type argument types the payload of the key function.
  static readonly middleware = [withoutOverlapping<typeof TypedMiddlewareJob>((payload) => `user:${payload.userId}`, { releaseAfter: 10 })];
  handle() {}
}
export class UntypedMiddlewareJob {
  static readonly job = 'auth.untyped-middleware';
  static readonly schema = ByUser;
  // @ts-expect-error — without it the payload is unknown
  static readonly middleware = [withoutOverlapping((payload) => `user:${payload.userId}`)];
  handle() {}
}

export async function Once(job: JobContext) {
  const ran: boolean = await job.once('welcome-mail:1', () => undefined, { for: 3600 });
  // @ts-expect-error — the key is a string
  await job.once(1, () => undefined);
  return ran;
}

export function UniqueAndChainAssertions(app: TestApp) {
  app.queue.assertDispatched(RebuildMemberStatsJob, undefined, { unique: 'members' });
  app.queue.assertChained([[SendWelcomeMailJob, { userId: 1 }], RebuildMemberStatsJob]);
  // @ts-expect-error — the unique key is a string
  app.queue.assertDispatched(RebuildMemberStatsJob, undefined, { unique: 1 });
}
