import { Application, EventRegistry, type Container } from '@marmeon/core';
import type { AppCheck, CheckProblem } from 'marmeon';
import { slotTarget } from './guard-slot.ts';
import { GuardSlotError, SlotBindings } from './slot-bindings.ts';
import { slotOfEvent } from './slot-events.ts';

/** A listener's name for a message: never its value, and never a `static name` that is no string. */
function listenerName(listener: unknown): string {
  const name = typeof listener === 'function' ? (listener as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name !== '' ? name : '(anonymous)';
}

/**
 * What is wrong with the guard slots of a booted app: one message for each slot whose events have listeners while it is unbound, or bound
 * to a guard no provider registered (A8). Nothing is dispatched for such a slot, so its listeners would stay silent. A listener is not
 * tied to a route, so no route check sees it; the start (`checkStart`) and the `guard-slots` check both ask here. Only after every
 * provider has booted, when a binding can no longer come. @internal
 */
export function guardSlotProblems(container: Container): string[] {
  // By the slot object, not its name: two slots may share one.
  const slots = new Map<object, { name: string; listeners: string[] }>();
  for (const { event, listener } of container.make(EventRegistry).all()) {
    const owner = slotOfEvent(event);
    if (owner === undefined) continue;
    const found = slots.get(owner.slot) ?? { name: owner.name, listeners: [] };
    found.listeners.push(listenerName(listener));
    slots.set(owner.slot, found);
  }
  const bindings = container.has(SlotBindings) ? container.make(SlotBindings) : undefined;
  const messages: string[] = [];
  for (const [slot, { name, listeners }] of slots) {
    if (bindings?.target(slot) === undefined) {
      messages.push(`The guard slot '${name}' has listeners (${listeners.join(', ')}) but is not bound, so its events are never dispatched: register the provider of the package that defines the slot, or bind it there in register() or boot()`);
      continue;
    }
    // The resolution the gate and the middleware make, so a slot bound to a guard nobody registered is found as well.
    try {
      slotTarget(slot, (key) => container.make(key as never));
    } catch (error) {
      if (!(error instanceof GuardSlotError)) throw error;
      messages.push(`${error.detail} Its listeners (${listeners.join(', ')}) never hear an event.`);
    }
  }
  return messages;
}

/**
 * The `guard-slots` check of `marmeon check`: {@link guardSlotProblems} as findings, for an app that is booted. The start refuses the
 * same slots. See docs/check.md#the-app-checks.
 */
export class GuardSlotsCheck implements AppCheck {
  static check = 'guard-slots';
  static phase = 'run' as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  handle(): readonly CheckProblem[] {
    return guardSlotProblems(this.#app.container).map(
      (message): CheckProblem => ({
        severity: 'error',
        code: 'A8',
        message,
      }),
    );
  }
}
