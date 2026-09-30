import type { Resolver } from './container.ts';

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

export interface ListenerBinding {
  readonly event: EventClass;
  readonly listener: ListenerLike<any>;
}

/**
 * Declares that `listener` handles `event` — for a module's `listeners` list:
 *
 * ```ts
 * defineModule({ name: 'user-profile', listeners: [listen(UserLoggedIn, RecordLastLogin)] });
 * ```
 */
export function listen<TEvent extends object>(event: EventClass<TEvent>, listener: ListenerLike<NoInfer<TEvent>>): ListenerBinding {
  return { event, listener };
}

/** Which listeners handle which events. One per application. */
export class EventRegistry {
  readonly #listeners = new Map<EventClass, ListenerLike<any>[]>();

  listen<TEvent extends object>(event: EventClass<TEvent>, listener: ListenerLike<NoInfer<TEvent>>): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }

  add(bindings: readonly ListenerBinding[]): this {
    for (const { event, listener } of bindings) this.listen(event, listener);
    return this;
  }

  /** Listeners of the event's class and of every class it extends, most specific first. */
  listenersFor(event: object): ListenerLike<any>[] {
    const found: ListenerLike<any>[] = [];
    for (let proto = Object.getPrototypeOf(event); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      found.push(...(this.#listeners.get(proto.constructor) ?? []));
    }
    return found;
  }
}

/**
 * Dispatches events synchronously: listeners run in registration order, each awaited.
 * An error stops the dispatch and propagates to the caller — in a request, the
 * exception handler. Queued listeners follow with the queue (Wave 6).
 *
 * Created per resolution and bound to the container that asked for it, so in a
 * request, listeners are built from the request scope and may use scoped services.
 */
export class EventDispatcher {
  readonly #registry: EventRegistry;
  readonly #resolver: Resolver;

  constructor(registry: EventRegistry, resolver: Resolver) {
    this.#registry = registry;
    this.#resolver = resolver;
  }

  async dispatch<TEvent extends object>(event: TEvent): Promise<void> {
    for (const listener of this.#registry.listenersFor(event)) {
      if (isListenerClass(listener)) await this.#resolver.make(listener).handle(event);
      else await listener(event);
    }
  }
}

function isListenerClass(listener: ListenerLike<any>): listener is new (...args: any[]) => Listener<any> {
  return typeof listener.prototype?.handle === 'function';
}
