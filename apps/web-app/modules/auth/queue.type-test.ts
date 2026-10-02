// Type guarantees of the queue (W6 step 3) — compiled by `pnpm typecheck` / `bespoke build`, never run.
import { defineModule } from '@bespokecore/core';
import { Queue, type JobPayload } from '@bespokecore/queue';
import type { TestApp } from '@bespokecore/testing';
import * as v from 'valibot';
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
  await queue.bulk([[SendWelcomeMailJob, { userId: '1' }]]);
  return id;
}

export function Payload(payload: JobPayload<typeof SendWelcomeMailJob>) {
  const userId: number = payload.userId;
  // @ts-expect-error — only what the schema describes
  return payload.email ?? userId;
}

class NoName {
  static readonly schema = v.object({});
  handle() {}
}
class NoHandle {
  static readonly job = 'auth.no-handle';
  static readonly schema = v.object({});
}
class WithDate {
  static readonly job = 'auth.with-date';
  static readonly schema = v.object({ at: v.date() });
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
  app.queue.assertDispatched(SendWelcomeMailJob, (payload) => payload.userId > 0);
  // @ts-expect-error — the match is a part of the payload
  app.queue.assertDispatched(SendWelcomeMailJob, { userId: '1' });
}
