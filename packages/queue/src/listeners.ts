import type { Container, EventClass, EventRegistry, ListenerQueue, QueueableEvent, QueuedListenerClass, QueuedListenerOptions, Resolver, StandardSchemaV1 } from '@marmeon/core';
import { durationToSeconds, type Duration } from '@marmeon/core';
import { isQueuedListener, withCode } from '@marmeon/core/internal';
import * as v from 'valibot';
import type { JobContext } from './job.ts';
import { RECORD_OPTIONS, type Queue } from './queue.ts';
import { JobEvent } from './events.ts';
import { QueueError, QueueSetupError } from './registry.ts';
import { describeIssues, JobPayloadError, TARGET_UNKNOWN, toJson } from './runner.ts';

/** `auth.registered` — like a job's name. */
const NAME = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;

/** A queued listener, found by the names its job carries. */
interface QueuedTarget {
  readonly event: EventClass & QueueableEvent;
  readonly listener: QueuedListenerClass;
}

/**
 * The app's queued listeners, by event name and listener name — checked at startup: every event with a queued
 * listener can be queued (`static event`, `static schema`), names are unique, `static queue` holds sensible settings.
 *
 * A listener is known by its `static listener` within its event — never by its class name, which a rename or a minifier
 * changes. Renaming that string while jobs of it wait leaves them unrun, like renaming a job's `static job`.
 */
export class QueuedListeners {
  readonly #byEvent = new Map<string, { readonly event: EventClass & QueueableEvent; readonly listeners: Map<string, QueuedListenerClass> }>();

  constructor(registry: EventRegistry) {
    for (const { event, listener } of registry.all()) {
      if (!isQueuedListener(listener)) continue;
      const queueable = checkQueueableEvent(event, listener);
      checkListenerName(listener);
      checkListenerOptions(listener);
      const entry = this.#byEvent.get(queueable.event) ?? { event: queueable, listeners: new Map<string, QueuedListenerClass>() };
      if (entry.event !== queueable) {
        throw new QueueSetupError(
          withCode('Q4', `Two events are named "${queueable.event}": ${entry.event.name} and ${queueable.name}. An event's name is how a worker finds its class for a queued listener — give each its own static event.`),
        );
      }
      const known = entry.listeners.get(listener.listener);
      if (known && known !== listener) {
        throw new QueueSetupError(
          withCode('Q4', `${known.name} and ${listener.name}, both queued listeners of ${queueable.name}, have the same static listener "${listener.listener}". A worker finds a queued listener by that name within the event — give each its own.`),
        );
      }
      entry.listeners.set(listener.listener, listener);
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
    throw new QueueSetupError(withCode('Q4',
      `${listener.name} is a queued listener (static queue) of ${label}, which cannot be queued: give ${label} static event = 'module.what-happened' (a stable name — never the class name)` +
        ` and static schema (what is queued of it, as JSON — IDs, not records).` +
        (jobEvent ? ' Job events (JobQueued …) never can: their listeners run where the job runs — remove static queue.' : '') +
        (typeof statics.event === 'string' ? ` "${statics.event}" is not a name like that.` : '')),
    );
  }
  if (typeof (statics.schema as StandardSchemaV1 | undefined)?.['~standard']?.validate !== 'function') {
    throw new QueueSetupError(withCode('Q4', `${label} (${statics.event}) has a queued listener (${listener.name}) and needs static schema — a Standard Schema of what is queued of it, e.g. v.object({ userId: v.number() }).`));
  }
  return event as EventClass & QueueableEvent;
}

/** `SendWelcomeMail` → `send-welcome-mail`, for the suggestion in a message. */
function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().replace(/^-|-$/g, '') || 'name';
}

function checkListenerName(listener: QueuedListenerClass): void {
  const name = (listener as { listener?: unknown }).listener;
  if (typeof name === 'string' && NAME.test(name)) return;
  const label = `${listener.name || 'A queued listener'} (static queue)`;
  throw new QueueSetupError(
    typeof name === 'string'
      ? withCode('Q4', `${label}: "${name}" is not a name like 'module.send-welcome-mail' — lowercase words joined by . : _ or -.`)
      : withCode('Q3', `${label} needs static listener — the stable name its queued jobs carry, never the class name (a rename or a minifier changes that): static listener = '<module>.${kebab(listener.name)}'.`),
  );
}

function checkListenerOptions(listener: QueuedListenerClass): void {
  const options = listener.queue as QueuedListenerOptions & Record<string, unknown>;
  const label = `${listener.name} (static queue)`;
  if (typeof listener.prototype?.handle !== 'function') throw new QueueSetupError(withCode('Q4', `${label} needs a handle(payload) method.`));
  for (const key of Object.keys(options)) {
    if (key === 'afterCommit') throw new QueueSetupError(withCode('Q4', `${label}: afterCommit is always on: queued listeners join the transaction — remove it.`));
    if (!['queue', 'connection', 'delay', 'tries', 'backoff'].includes(key)) {
      throw new QueueSetupError(withCode('Q4', `${label}: unknown setting "${key}" — static queue takes queue, connection, delay, tries and backoff.`));
    }
  }
  for (const key of ['queue', 'connection'] as const) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key] === '')) throw new QueueSetupError(withCode('Q4', `${label}: ${key} must be a name, not ${JSON.stringify(options[key])}.`));
  }
  const { tries, backoff } = options;
  if (tries !== undefined && (!Number.isInteger(tries) || tries < 1)) throw new QueueSetupError(withCode('Q4', `${label}: tries must be a whole number ≥ 1, not ${String(tries)}.`));
  if (backoff !== undefined && backoffSeconds(backoff) === undefined) {
    throw new QueueSetupError(withCode('Q4', `${label}: backoff must be seconds ≥ 0 — a number, a duration like { minutes: 1 }, or a list like [10, { minutes: 1 }, 300].`));
  }
}

/** The seconds before each retry, or `undefined` when `backoff` is not a duration or a list of them (or one is negative). */
function backoffSeconds(backoff: unknown): number[] | undefined {
  const list: unknown[] = Array.isArray(backoff) ? backoff : [backoff];
  try {
    const seconds = list.map((delay) => durationToSeconds(delay as Duration));
    return seconds.every((value) => value >= 0) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** What the framework job behind a queued listener carries: the event's name, the listener's name and the event's payload as it was queued. */
export interface QueuedListenerPayload {
  event: string;
  listener: string;
  payload: unknown;
}

/** @internal The validation behind `CallQueuedListener.schema`; the type tests compare its output with `QueuedListenerPayload`. */
export const queuedListenerSchema = v.object({ event: v.string(), listener: v.string(), payload: v.unknown() });

/**
 * The framework job behind every queued listener: the event's name, the listener's name and the event's payload.
 * Encrypted — an event's payload is the app's, and may carry more than IDs.
 */
export class CallQueuedListener {
  static readonly job = 'marmeon.listener';
  static readonly schema: StandardSchemaV1<QueuedListenerPayload> = queuedListenerSchema;
  static readonly encrypted = true;

  readonly #resolver: Resolver;
  readonly #listeners: QueuedListeners;

  constructor(resolver: Resolver, listeners: QueuedListeners) {
    this.#resolver = resolver;
    this.#listeners = listeners;
  }

  /**
   * @internal Asked before the job runs: why this app has no listener for the job, if so. Such a job is foreign to this
   * worker — a newer one may know it — and never runs another listener.
   */
  static [TARGET_UNKNOWN](container: Container, data: QueuedListenerPayload): string | undefined {
    if (container.make(QueuedListeners).find(data.event, data.listener)) return undefined;
    return `No queued listener "${data.listener}" of the event "${data.event}" is registered in this app (a deploy in progress, or the listener's static listener was changed or removed).`;
  }

  async handle(data: QueuedListenerPayload, job: JobContext): Promise<void> {
    const target = this.#listeners.find(data.event, data.listener);
    if (!target) throw new QueueError(`No queued listener "${data.listener}" of the event "${data.event}" in this app.`);
    const result = await target.event.schema['~standard'].validate(data.payload);
    // A deploy changed the event's schema: it never will match — failed at once, like a job's payload.
    if (result.issues) return job.fail(new JobPayloadError(`The payload no longer matches the schema of the event ${data.event} (${data.listener}): ${describeIssues(result.issues)}`, result.issues));
    await this.#resolver.make(target.listener).handle(result.value);
  }
}

/**
 * Queues queued listeners — the app's `ListenerQueue`: the event checked against its schema now (a mismatch is the
 * dispatcher's error), as JSON, in a `marmeon.listener` job on the listener's queue — dispatched like any job: inside a
 * transaction it exists only with the commit (a database queue writes it into the transaction itself, other connections
 * hold it until the commit), never after a rollback.
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
    if (this.#listeners.find(queueable.event, listener.listener)?.listener !== listener) {
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
      [RECORD_OPTIONS]: { ...(tries === undefined ? {} : { tries }), ...(backoff === undefined ? {} : { backoff: backoffSeconds(backoff) }) },
    };
    // The normal dispatch path: in a transaction, part of it — atomic with a database queue.
    await this.#queue().dispatch(CallQueuedListener as never, { event: queueable.event, listener: listener.listener, payload } as never, options);
  }
}
