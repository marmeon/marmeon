import type { Container, StandardResult, StandardSchemaV1 } from '@marmeon/core';
import type { Guard } from './define-guard.ts';
import { deriveEvents, type SlotEvents } from './guard-events.ts';
import { isGuardName } from './guard-names.ts';
import { SlotBindings } from './slot-bindings.ts';

/** The slot's event classes and what turns an event of the app's classes into the slot's. @internal */
export interface SlotEventSet {
  readonly events: SlotEvents<never>;
  /** The slot's event for a service's event raised in `guard`'s mode, or `undefined` for a class the slot has none of. */
  map(base: object, guard: string): object | undefined;
}

const ISSUE = "guard is 'web' or a guard's name";

/** Whether `guard` is a mode a slot's event may name. */
function isMode(guard: unknown): guard is string {
  return guard === 'web' || isGuardName(guard);
}

/** What a refusal says of a value: a string cut short, otherwise nothing of it (an untyped caller may hold a user record). */
function shown(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value.slice(0, 32)) : 'something else';
}

/**
 * The schema of the app's event with `guard` and `slot` in its output. The input is the slot's event as well as the payload that was queued:
 * `guard` is read from it and never filled in, so a payload queued in one mode keeps that mode on a worker bound to another. A missing or
 * malformed `guard` is an issue.
 */
function slotSchema(base: StandardSchemaV1, slotName: string): StandardSchemaV1 {
  const inner = base['~standard'];
  return {
    '~standard': {
      version: 1,
      vendor: inner.vendor,
      validate: (input, options) => {
        const add = (result: StandardResult<unknown>): StandardResult<unknown> => {
          if (result.issues !== undefined) return result;
          const guard = (input as { readonly guard?: unknown } | null | undefined)?.guard;
          if (!isMode(guard)) return { issues: [{ message: ISSUE, path: ['guard'] }] };
          return { ...result, value: { ...(result.value as object), guard, slot: slotName } };
        };
        const result = inner.validate(input, options);
        return result instanceof Promise ? result.then(add) : add(result);
      },
    },
  };
}

const SETS = new WeakMap<object, SlotEventSet>();
const OWNERS = new WeakMap<object, { readonly slot: object; readonly name: string }>();

/** The event classes of the slot named `slotName`, made once per slot. @internal */
export function slotEventSet(slotName: string): SlotEventSet {
  const { events, derived } = deriveEvents({
    className: (base) => `slot:${slotName}:${base}`,
    eventName: (event) => `slot.${slotName}.${event}`,
    schema: (base) => slotSchema(base, slotName),
    construct(Base, [guard, ...parameters], own) {
      // Never the value as it is: an untyped caller that passed a user first would put the record into a log.
      if (!isMode(guard)) throw new TypeError(`A guard slot's event takes the mode it happened in: 'web' or a guard's name; got ${shown(guard)}.`);
      Object.assign(own, new Base(...(parameters as never[])));
      Object.defineProperty(own, 'guard', { value: guard, enumerable: true });
    },
  });
  return {
    events: events as unknown as SlotEvents<never>,
    map(base, guard) {
      // The exact class, not `instanceof`: an event that is not one of the listed classes is dropped.
      const Own = derived.get((base as { constructor?: unknown }).constructor);
      if (Own === undefined) return undefined;
      return Object.defineProperty(Object.assign(Object.create(Own.prototype) as object, base), 'guard', { value: guard, enumerable: true });
    },
  };
}

/** Records the event classes of `slot` so that the relay finds them by the slot object, and their owner by class. @internal */
export function registerSlotEvents(slot: object, name: string, set: SlotEventSet): void {
  SETS.set(slot, set);
  for (const Class of Object.values(set.events)) OWNERS.set(Class, { slot, name });
}

/** The slot and its name that `Class` is an event class of, or `undefined` for any other class. @internal */
export function slotOfEvent(Class: unknown): { readonly slot: object; readonly name: string } | undefined {
  return typeof Class === 'function' ? OWNERS.get(Class) : undefined;
}

/**
 * The events of the slots bound to `target` in `container`, for `base`, an event of the app's classes that a service of `target` raised,
 * in binding order. Security: a slot is relayed only when its binding is this very target (`'web'` or the guard object), and a slot nobody
 * bound has no binding and gets nothing: there is no fallback to the app's users, so no event reaches a listener under the wrong mode.
 *
 * @internal
 */
export function slotEventsFor(container: Pick<Container, 'has' | 'make'>, target: 'web' | Guard, base: object): object[] {
  if (!container.has(SlotBindings)) return [];
  const relayed: object[] = [];
  for (const [slot, bound] of container.make(SlotBindings).entries()) {
    if (bound !== target) continue;
    const event = SETS.get(slot)?.map(base, target === 'web' ? 'web' : target.name);
    if (event !== undefined) relayed.push(event);
  }
  return relayed;
}
