// Type guarantees of the queued listener's payload — checked by `tsc` (typecheck), never run.
import * as v from 'valibot';
import type { CallQueuedListener, QueuedListenerPayload, queuedListenerSchema } from './listeners.ts';
import type { JobPayload } from './job.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// The annotation on `static schema` must not lie: the schema behind it infers exactly the named payload.
export type Output = Expect<Equal<v.InferOutput<typeof queuedListenerSchema>, QueuedListenerPayload>>;
export type Input = Expect<Equal<v.InferInput<typeof queuedListenerSchema>, QueuedListenerPayload>>;
export type Job = Expect<Equal<JobPayload<typeof CallQueuedListener>, QueuedListenerPayload>>;
