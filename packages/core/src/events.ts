import type { Duration } from './clock.ts';
import type { InferOutput, StandardSchemaV1 } from './config/standard-schema.ts';
import type { Resolver } from './container.ts';
import { token } from './token.ts';

/**
 * Any class whose instances are events. The class itself is the event's identity.
 *
 * Give every event class its own ECMAScript private field — `readonly #event = true;`.
 * TypeScript types classes structurally, so without it `UserLoggedIn { user }` and
 * `UserLoggedOut { user }` are the *same type*, and `listen()` could not tell a listener
 * for one from a listener for the other. A `#private` field makes the class nominal.
 * (At runtime the dispatcher always matches by class; this is about the compile-time check.)
 */
export type EventClass<TEvent extends object = object> = abstract new (...args: any[]) => TEvent;

/**
 * A listener instance. `handle` is a property on purpose: the listener's method is
 * then checked contravariantly, so a listener for another event is a compile error.
 */
export interface Listener<TEvent> {
  readonly handle: (event: TEvent) => void | Promise<void>;
}

/** A listener class (built from the container, so it gets constructor injection) or a closure. */
export type ListenerLike<TEvent> = (new (...args: any[]) => Listener<TEvent>) | ((event: TEvent) => void | Promise<void>);

/**
 * Where and how a queued listener runs (E86, E109) — its class's `static queue`:
 *
 * ```ts
 * export class SendEmailVerification {
 *   static readonly queue = { queue: 'mail' };          // on the `mail` queue
 *   async handle(payload: EventPayload<typeof Registered>) { … }
 * }
 * ```
 *
 * Its job is dispatched like any other (E107, E109): inside `connections.transaction()` it exists only once the
 * transaction commits and is gone after a rollback — a `database` queue writes it into the transaction itself (atomic
 * with the data), every other connection holds it until the commit. There is no `afterCommit` switch: it is always on.
 */
export interface QueuedListenerOptions {
  /** The queue (default: the connection's default queue). */
  readonly queue?: string;
  /** The queue connection (default: `QUEUE_CONNECTION`). */
  readonly connection?: string;
  /** Run no earlier than this — seconds, or a duration. */
  readonly delay?: number | Duration;
  /** Attempts in all (default 1: no retry). */
  readonly tries?: number;
  /** Seconds before the next attempt — one value, or one per retry (the last repeats). */
  readonly backoff?: number | readonly number[];
}

/**
 * The static side of an event that queued listeners can listen to (E86): a stable name and the schema of what is queued
 * of it — the event's own fields, as JSON (IDs, not records):
 *
 * ```ts
 * export class Registered {
 *   static readonly event = 'auth.registered';
 *   static readonly schema = v.object({ userId: v.number() });   // reads event.userId
 *   readonly #event = true;
 *   …
 *   get userId() { return this.user.id; }
 * }
 * ```
 */
export interface QueueableEvent {
  /** The event's stable name — what the queue stores, never the class name: `'auth.registered'`. */
  readonly event: string;
  /** What is queued of the event: validated against the event object itself, stored as JSON, validated again before the listener runs. */
  readonly schema: StandardSchemaV1;
}

/** What a queued listener's `handle()` gets: the output of the event's `static schema` — `handle(payload: EventPayload<typeof Registered>)`. */
export type EventPayload<E extends QueueableEvent> = InferOutput<E['schema']>;

/** A queued listener class: `static queue`, and `handle(payload)` — built through the container where it runs (a worker). */
export type QueuedListenerClass<P = any> = { readonly queue: QueuedListenerOptions } & (new (...args: any[]) => { readonly handle: (payload: P) => void | Promise<void> });

/** The input type of a Standard Schema. */
type SchemaInput<S> = S extends StandardSchemaV1 ? NonNullable<S['~standard']['types']>['input'] : never;

/** Whether `T` survives `JSON.stringify` → `JSON.parse` unchanged (optional properties may be left out). */
export type IsJson<T> = 0 extends 1 & T ? true : false extends JsonMember<T> ? false : true;
/** Per member of a union (distributive): `{ id: number } | null` is JSON, `string | Date` is not. */
type JsonMember<T> = T extends string | number | boolean | null
  ? true
  : T extends readonly (infer E)[]
    ? IsJson<E>
    : T extends Date | RegExp | Map<any, any> | Set<any> | ((...args: any[]) => any) | bigint | symbol | undefined
      ? false
      : T extends object
        ? false extends { [K in keyof T]-?: IsJson<Exclude<T[K], undefined>> }[keyof T]
          ? false
          : true
        : false;

type HandleParameter<L> = L extends new (...args: any[]) => { readonly handle: (payload: infer P) => unknown } ? P : never;

/** What `listen(event, listener)` checks — a failed check is a type whose name says what is wrong (message-as-type). */
type ListenerFor<E extends EventClass, L> = L extends { readonly queue: unknown } ? QueuedListenerFor<E, L> : ListenerLike<InstanceType<E>>;

type QueuedListenerFor<E extends EventClass, L> = L extends { readonly queue: { readonly afterCommit: unknown } }
  ? { readonly queue: { readonly afterCommit: 'afterCommit is always on: queued listeners join the transaction (E107/E109) — remove it' } }
  : E extends QueueableEvent
  ? IsJson<EventPayload<E>> extends false
    ? { readonly 'The static schema of a queued event describes JSON (strings, numbers, booleans, null, arrays, plain objects) — queue IDs, not records, Dates or Maps': EventPayload<E> }
    : InstanceType<E> extends SchemaInput<E['schema']>
      ? EventPayload<E> extends HandleParameter<L>
        ? { readonly queue: QueuedListenerOptions }
        : { readonly 'handle() of a queued listener gets the event payload (its static schema), not the event: type it as EventPayload<typeof YourEvent>': EventPayload<E> }
      : { readonly 'The static schema of a queued event reads the event object itself — the event class lacks a field the schema wants': SchemaInput<E['schema']> }
  : { readonly queue: 'A queued listener (static queue) needs an event that can be queued — give the event class static event = "module.what-happened" and static schema. Job events (JobQueued …) never can: listen to them without static queue.' };

export interface ListenerBinding {
  readonly event: EventClass;
  readonly listener: ListenerLike<any> | QueuedListenerClass;
}

/**
 * Declares that `listener` handles `event` — for a module's `listeners` list:
 *
 * ```ts
 * defineModule({ name: 'user-profile', listeners: [listen(UserLoggedIn, RecordLastLogin)] });
 * ```
 *
 * A listener class with `static queue` is **queued** (E86): the dispatch queues it as a job (`bespoke.listener`, needs
 * @bespokecore/queue) and a worker runs it — with the event's payload (`EventPayload<typeof E>`, its `static schema`),
 * not the event object. Such an event needs `static event` and `static schema`.
 */
export function listen<E extends EventClass, L>(event: E, listener: L & ListenerFor<E, NoInfer<L>>): ListenerBinding {
  return { event, listener: listener as ListenerBinding['listener'] };
}

/** Which listeners handle which events. One per application. */
export class EventRegistry {
  readonly #listeners = new Map<EventClass, ListenerBinding['listener'][]>();

  listen<E extends EventClass, L>(event: E, listener: L & ListenerFor<E, NoInfer<L>>): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener as ListenerBinding['listener']);
    this.#listeners.set(event, list);
    return this;
  }

  add(bindings: readonly ListenerBinding[]): this {
    for (const { event, listener } of bindings) this.listen(event, listener as never);
    return this;
  }

  /** Listeners of the event's class and of every class it extends, most specific first. */
  listenersFor(event: object): ListenerBinding['listener'][] {
    return this.bindingsFor(event).map((binding) => binding.listener);
  }

  /** Like {@link listenersFor}, with the class each listener was registered for. */
  bindingsFor(event: object): ListenerBinding[] {
    const found: ListenerBinding[] = [];
    for (let proto = Object.getPrototypeOf(event); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const listener of this.#listeners.get(proto.constructor) ?? []) found.push({ event: proto.constructor, listener });
    }
    return found;
  }

  /** Every registration, in order. */
  all(): ListenerBinding[] {
    return [...this.#listeners].flatMap(([event, listeners]) => listeners.map((listener) => ({ event, listener })));
  }
}

/**
 * Queues a queued listener (E86) — bound by @bespokecore/queue. The dispatcher hands it the event, the class the
 * listener was registered for and the listener.
 */
export interface ListenerQueue {
  queue(event: object, registeredFor: EventClass, listener: QueuedListenerClass): Promise<void>;
}
export const ListenerQueue = token<ListenerQueue>('ListenerQueue');

/** Whether a listener is queued: a class with `static queue` (E86). */
export function isQueuedListener(listener: unknown): listener is QueuedListenerClass {
  return typeof listener === 'function' && typeof (listener as { queue?: unknown }).queue === 'object' && (listener as { queue?: unknown }).queue !== null;
}

/** The message when a queued listener exists but nothing can queue it. */
export function missingListenerQueue(listener: { readonly name: string }): string {
  return `${listener.name} is a queued listener (static queue), but this app has no queue — install and register @bespokecore/queue (pnpm add @bespokecore/queue; bespoke discover), or remove static queue to run it at the dispatch.`;
}

/** Sees every dispatched event first — and decides whether its listeners run (an `EventFake` in tests). */
export interface EventObserver {
  /** Called once per dispatch, before any listener; `false`: no listener runs. */
  observe(event: object): boolean;
}

export interface EventDispatcherOptions {
  /** Queues queued listeners — the app's {@link ListenerQueue}, if it has one. */
  readonly queue?: () => ListenerQueue | undefined;
  readonly observer?: EventObserver;
}

/**
 * Dispatches events: listeners run in registration order, each awaited. A queued listener (`static queue`, E86) is
 * queued at its place in that order — like any dispatch, part of the transaction around it (E107, E109) — and runs
 * later in a worker.
 *
 * An error stops the dispatch and propagates to the caller — in a request, the exception handler. The listeners after
 * the failing one do not run and are not queued; inside `connections.transaction()` the rollback drops the queued ones
 * before it as well. For all or nothing, dispatch inside a transaction.
 *
 * Created per resolution and bound to the container that asked for it, so in a
 * request, listeners are built from the request scope and may use scoped services.
 */
export class EventDispatcher {
  readonly #registry: EventRegistry;
  readonly #resolver: Resolver;
  readonly #options: EventDispatcherOptions;

  constructor(registry: EventRegistry, resolver: Resolver, options: EventDispatcherOptions = {}) {
    this.#registry = registry;
    this.#resolver = resolver;
    this.#options = options;
  }

  async dispatch<TEvent extends object>(event: TEvent): Promise<void> {
    if (this.#options.observer && !this.#options.observer.observe(event)) return;
    for (const { event: registeredFor, listener } of this.#registry.bindingsFor(event)) {
      if (isQueuedListener(listener)) {
        const queue = this.#options.queue?.();
        if (!queue) throw new Error(missingListenerQueue(listener));
        await queue.queue(event, registeredFor, listener);
      } else if (isListenerClass(listener)) await this.#resolver.make(listener).handle(event);
      else await (listener as (event: TEvent) => unknown)(event);
    }
  }
}

function isListenerClass(listener: ListenerBinding['listener']): listener is new (...args: any[]) => Listener<any> {
  return typeof listener.prototype?.handle === 'function';
}
