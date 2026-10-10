import { AssertionError } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { isQueuedListener, type EventClass, type EventObserver, type EventRegistry, type ListenerBinding } from './events.ts';

/** Which dispatches an assertion means: a part of the event (`{ orderId: 'o-1' }`), or a test of the event. */
export type EventMatch<E extends object> = Partial<E> | ((event: E) => boolean);

/**
 * Records every dispatched event — `@marmeon/testing` binds it in each test app (`app.events`):
 *
 * ```ts
 * await app.post('/register', { form }).assertRedirect();
 * app.events.assertDispatched(Registered, (event) => event.user.email === 'kj@example.com');
 * ```
 *
 * Faked events (`createTestApp(app, { events: 'fake' })`, or only some: `{ events: [Registered] }`) are recorded and
 * nothing else — their listeners neither run nor are queued. Every other event is recorded and dispatched as usual.
 */
export class EventFake implements EventObserver {
  readonly #faked: 'all' | ReadonlySet<EventClass>;
  readonly #registry: EventRegistry;
  readonly #dispatched: object[] = [];

  /** `faked`: every event (`'all'`), some (their classes and subclasses), or none (`[]` — record only). */
  constructor(registry: EventRegistry, faked: 'all' | readonly EventClass[] = []) {
    this.#registry = registry;
    this.#faked = faked === 'all' ? 'all' : new Set(faked);
  }

  observe(event: object): boolean {
    this.#dispatched.push(event);
    return !this.isFaked(event);
  }

  /** Whether the listeners of `event` are held back. */
  isFaked(event: object): boolean {
    if (this.#faked === 'all') return true;
    for (const Class of this.#faked) if (event instanceof Class) return true;
    return false;
  }

  /** The dispatched events of a class (and its subclasses), optionally only the matching ones, oldest first. */
  dispatched<E extends object>(Class: EventClass<E>, match?: EventMatch<E>): E[] {
    return this.#dispatched.filter((event): event is E => event instanceof Class && matches(event as E, match));
  }

  assertDispatched<E extends object>(Class: EventClass<E>, match?: EventMatch<E>): this {
    if (this.dispatched(Class, match).length === 0) {
      throw new AssertionError({ message: `Expected ${Class.name} to be dispatched${match ? ' matching the given test' : ''}. Dispatched: ${this.#summary()}.` });
    }
    return this;
  }

  assertDispatchedTimes<E extends object>(Class: EventClass<E>, times: number, match?: EventMatch<E>): this {
    const actual = this.dispatched(Class, match).length;
    if (actual !== times) throw new AssertionError({ message: `Expected ${times} × ${Class.name}, dispatched ${actual}.`, actual, expected: times });
    return this;
  }

  assertNotDispatched<E extends object>(Class: EventClass<E>, match?: EventMatch<E>): this {
    const found = this.dispatched(Class, match).length;
    if (found > 0) throw new AssertionError({ message: `Expected no ${Class.name}${match ? ' matching the given test' : ''} to be dispatched, found ${found}.` });
    return this;
  }

  assertNothingDispatched(): this {
    if (this.#dispatched.length > 0) throw new AssertionError({ message: `Expected no event to be dispatched. Dispatched: ${this.#summary()}.` });
    return this;
  }

  /** `listener` is registered for `Class` (`listen(Class, listener)` in a module) — queued or not. */
  assertListening(Class: EventClass, listener: ListenerBinding['listener']): this {
    const found = this.#registry.all().some((binding) => binding.event === Class && binding.listener === listener);
    if (!found) {
      const name = (listener as { name?: string }).name || 'the closure';
      const listeners = this.#registry
        .all()
        .filter((binding) => binding.event === Class)
        .map((binding) => `${(binding.listener as { name?: string }).name || 'a closure'}${isQueuedListener(binding.listener) ? ' (queued)' : ''}`);
      throw new AssertionError({ message: `Expected ${name} to listen to ${Class.name}. Its listeners: ${listeners.join(', ') || 'none'}.` });
    }
    return this;
  }

  #summary(): string {
    return this.#dispatched.length === 0 ? 'nothing' : this.#dispatched.map((event) => event.constructor.name).join(', ');
  }
}

function matches<E extends object>(event: E, match: EventMatch<E> | undefined): boolean {
  if (match === undefined) return true;
  if (typeof match === 'function') return match(event);
  return Object.entries(match).every(([key, value]) => isDeepStrictEqual((event as Record<string, unknown>)[key], value));
}
