import {
  type EventClass,
  type EventRegistry,
  isQueuedListener,
  type ListenerQueue,
  type QueueableEvent,
  type QueuedListenerClass,
  type QueuedListenerOptions,
  type Resolver,
  type StandardSchemaV1,
} from '@marmeon/core';
import * as v from 'valibot';
import type { JobContext } from './job.ts';
import { RECORD_OPTIONS, type Queue } from './queue.ts';
import { JobEvent } from './events.ts';
import { QueueError, QueueSetupError } from './registry.ts';
import { describeIssues, JobPayloadError, toJson } from './runner.ts';

/** `auth.registered` — like a job's name. */
const NAME = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;

/** A queued listener, found by the names its job carries. */
interface QueuedTarget {
  readonly event: EventClass & QueueableEvent;
  readonly listener: QueuedListenerClass;
}

/**
 * The app's queued listeners (E86), by event name and listener name — checked at startup: every event with a queued
 * listener can be queued (`static event`, `static schema`), names are unique, `static queue` holds sensible settings.
 *
 * A listener is known by its class name within its event: renaming a queued listener's class while jobs of it wait
 * makes them fail ("no queued listener … — renamed or removed?") — like renaming a job's `static job`.
 */
export class QueuedListeners {
  readonly #byEvent = new Map<string, { readonly event: EventClass & QueueableEvent; readonly listeners: Map<string, QueuedListenerClass> }>();

  constructor(registry: EventRegistry) {
    for (const { event, listener } of registry.all()) {
      if (!isQueuedListener(listener)) continue;
      const queueable = checkQueueableEvent(event, listener);
      checkListenerOptions(listener);
      const entry = this.#byEvent.get(queueable.event) ?? { event: queueable, listeners: new Map<string, QueuedListenerClass>() };
      if (entry.event !== queueable) {
        throw new QueueSetupError(
          `Two events are named "${queueable.event}": ${entry.event.name} and ${queueable.name}. An event's name is how a worker finds its class for a queued listener — give each its own static event.`,
        );
      }
      const known = entry.listeners.get(listener.name);
      if (known && known !== listener) {
        throw new QueueSetupError(`Two queued listeners of ${queueable.name} are named ${listener.name}. A worker finds a queued listener by its class name within the event — rename one.`);
      }
      entry.listeners.set(listener.name, listener);
      this.#byEvent.set(queueable.event, entry);
    }
  }

  /** Whether the app has any queued listener. */
  get any(): boolean {
    return this.#byEvent.size > 0;
  }

  find(event: string, listener: string): QueuedTarget | undefined {
    const entry = this.#byEvent.get(event);
    const found = entry?.listeners.get(listener);
    return entry && found ? { event: entry.event, listener: found } : undefined;
  }
}

/** The event class a queued listener listens to, after checking it can be queued. */
export function checkQueueableEvent(event: EventClass, listener: { readonly name: string }): EventClass & QueueableEvent {
  const statics = event as unknown as Partial<QueueableEvent>;
  const label = event.name || 'the event';
  const jobEvent = event === (JobEvent as EventClass) || event.prototype instanceof JobEvent;
  if (typeof statics.event !== 'string' || !NAME.test(statics.event)) {
    throw new QueueSetupError(
      `${listener.name} is a queued listener (static queue) of ${label}, which cannot be queued: give ${label} static event = 'module.what-happened' (a stable name — never the class name)` +
        ` and static schema (what is queued of it, as JSON — IDs, not records).` +
        (jobEvent ? ' Job events (JobQueued …) never can: their listeners run where the job runs — remove static queue.' : '') +
        (typeof statics.event === 'string' ? ` "${statics.event}" is not a name like that.` : ''),
    );
  }
  if (typeof (statics.schema as StandardSchemaV1 | undefined)?.['~standard']?.validate !== 'function') {
    throw new QueueSetupError(`${label} (${statics.event}) has a queued listener (${listener.name}) and needs static schema — a Standard Schema of what is queued of it, e.g. v.object({ userId: v.number() }).`);
  }
  return event as EventClass & QueueableEvent;
}

function checkListenerOptions(listener: QueuedListenerClass): void {
  const options = listener.queue as QueuedListenerOptions & Record<string, unknown>;
  const label = `${listener.name} (static queue)`;
  if (typeof listener.prototype?.handle !== 'function') throw new QueueSetupError(`${label} needs a handle(payload) method.`);
  for (const key of Object.keys(options)) {
    if (key === 'afterCommit') throw new QueueSetupError(`${label}: afterCommit is always on: queued listeners join the transaction (E107/E109) — remove it.`);
    if (!['queue', 'connection', 'delay', 'tries', 'backoff'].includes(key)) {
      throw new QueueSetupError(`${label}: unknown setting "${key}" — static queue takes queue, connection, delay, tries and backoff.`);
    }
  }
  for (const key of ['queue', 'connection'] as const) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key] === '')) throw new QueueSetupError(`${label}: ${key} must be a name, not ${JSON.stringify(options[key])}.`);
  }
  const { tries, backoff } = options;
  if (tries !== undefined && (!Number.isInteger(tries) || tries < 1)) throw new QueueSetupError(`${label}: tries must be a whole number ≥ 1, not ${String(tries)}.`);
  const delays = backoff === undefined ? [] : typeof backoff === 'number' ? [backoff] : backoff;
  if (!Array.isArray(delays) || delays.some((delay) => !(typeof delay === 'number' && delay >= 0))) {
    throw new QueueSetupError(`${label}: backoff must be seconds ≥ 0 — a number or a list like [10, 60, 300].`);
  }
}

/**
 * The framework job behind every queued listener (E86): the event's name, the listener's name and the event's payload.
 * Encrypted (E105) — an event's payload is the app's, and may carry more than IDs.
 */
export class CallQueuedListener {
  static readonly job = 'marmeon.listener';
  static readonly schema = v.object({ event: v.string(), listener: v.string(), payload: v.unknown() });
  static readonly encrypted = true;

  readonly #resolver: Resolver;
  readonly #listeners: QueuedListeners;

  constructor(resolver: Resolver, listeners: QueuedListeners) {
    this.#resolver = resolver;
    this.#listeners = listeners;
  }

  async handle(data: v.InferOutput<typeof CallQueuedListener.schema>, job: JobContext): Promise<void> {
    const target = this.#listeners.find(data.event, data.listener);
    // A deploy renamed or removed it — or this worker runs an older version (a rolling deploy): retried by its tries.
    if (!target) throw new QueueError(`No queued listener ${data.listener} of the event ${data.event} in this app — was it renamed or removed?`);
    const result = await target.event.schema['~standard'].validate(data.payload);
    // A deploy changed the event's schema: it never will match — failed at once, like a job's payload.
    if (result.issues) return job.fail(new JobPayloadError(`The payload no longer matches the schema of the event ${data.event} (${data.listener}): ${describeIssues(result.issues)}`, result.issues));
    await this.#resolver.make(target.listener).handle(result.value);
  }
}

/**
 * Queues queued listeners (E86) — the app's `ListenerQueue`: the event checked against its schema now (a mismatch is the
 * dispatcher's error), as JSON, in a `marmeon.listener` job on the listener's queue — dispatched like any job (E107,
 * E109): inside a transaction it exists only with the commit (a database queue writes it into the transaction itself,
 * other connections hold it until the commit), never after a rollback.
 */
export class QueueListenerDispatcher implements ListenerQueue {
  readonly #queue: () => Queue;
  readonly #listeners: QueuedListeners;

  constructor(queue: () => Queue, listeners: QueuedListeners) {
    this.#queue = queue;
    this.#listeners = listeners;
  }

  async queue(event: object, registeredFor: EventClass, listener: QueuedListenerClass): Promise<void> {
    const queueable = checkQueueableEvent(registeredFor, listener);
    if (this.#listeners.find(queueable.event, listener.name)?.listener !== listener) {
      throw new QueueError(`${listener.name} is not a registered queued listener of ${queueable.name} — list it in a module: listen(${queueable.name}, ${listener.name}).`);
    }
    const result = await queueable.schema['~standard'].validate(event);
    if (result.issues) {
      throw new JobPayloadError(`${queueable.name} cannot be queued for ${listener.name}: its static schema rejects the event — ${describeIssues(result.issues)}`, result.issues);
    }
    const payload = toJson(CallQueuedListener, result.value);
    const { queue, connection, delay, tries, backoff } = listener.queue;
    const options = {
      ...(queue === undefined ? {} : { queue }),
      ...(connection === undefined ? {} : { connection }),
      ...(delay === undefined ? {} : { delay }),
      [RECORD_OPTIONS]: { ...(tries === undefined ? {} : { tries }), ...(backoff === undefined ? {} : { backoff: typeof backoff === 'number' ? [backoff] : backoff }) },
    };
    // The normal dispatch path (E109): in a transaction, part of it — atomic with a database queue.
    await this.#queue().dispatch(CallQueuedListener as never, { event: queueable.event, listener: listener.name, payload } as never, options);
  }
}
