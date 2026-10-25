// Type guarantees of the queued listener's payload — checked by `tsc` (typecheck), never run.
import * as v from 'valibot';
import type { CallQueuedListener, QueuedListenerPayload, queuedListenerSchema } from './listeners.ts';
import type { JobPayload } from './job.ts';
import type { QueueConnection } from './driver.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// The annotation on `static schema` must not lie: the schema behind it infers exactly the named payload.
export type Output = Expect<Equal<v.InferOutput<typeof queuedListenerSchema>, QueuedListenerPayload>>;
export type Input = Expect<Equal<v.InferInput<typeof queuedListenerSchema>, QueuedListenerPayload>>;
export type Job = Expect<Equal<JobPayload<typeof CallQueuedListener>, QueuedListenerPayload>>;

// The unit is part of the name: a driver factory returns `retryAfterSeconds`.
// @ts-expect-error `retryAfter` is gone
export type NoUnitlessRetryAfter = QueueConnection['retryAfter'];
export type RetryAfterSeconds = Expect<Equal<QueueConnection['retryAfterSeconds'], number>>;
