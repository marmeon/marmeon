/**
 * Calling code the client core does not own — listeners of events, of a page, of a layer, of flash messages, a patch: its
 * bug must not break the navigation, nor cost the other listeners their call. It is thrown again later (in a microtask),
 * where the browser reports it.
 */

/** Throws `error` again, out of the current call (the console, `window.onerror`). */
export function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

/** Calls `listener` — a throw is rethrown later, never here. */
export function call<A extends readonly unknown[]>(listener: (...args: A) => void, ...args: A): void {
  try {
    listener(...args);
  } catch (error) {
    rethrowLater(error);
  }
}

/** Calls every listener, in order — one that throws does not keep the others from their call. */
export function notify<A extends readonly unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void {
  for (const listener of listeners) call(listener, ...args);
}
