/**
 * The client hook API: typed events an app — analytics, an error tracker, a rule of its own — listens to across every
 * visit, without wrapping each one. `before` may cancel a visit before its request is sent; `invalid` reports the validation
 * errors a visit's answer brought. A feature, not the core: an app that listens to nothing carries none of it. Attached where
 * it is used: `navigator.use(hooks).on('before', …)`. It keeps no data: only its listeners, never what an event carried.
 */
import type { ValidationErrors } from '../../page.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature, type PendingVisit } from '../feature.ts';
import type { VisitMethod, VisitOptions } from '../navigation.ts';
import { notify } from '../notify.ts';

/** A visit about to start — `before`'s event. */
export interface BeforeVisit {
  /** Where it goes, absolute (`https://app.test/users/2?tab=links`). */
  readonly url: string;
  readonly method: VisitMethod;
  /** Its options as the visit was asked for (`data`, `only`, `async`, `layer`, `name`, …) — to read, never to change. */
  readonly options: Readonly<VisitOptions>;
  /** A layer's visit: sent from a layer, or opening one. */
  readonly layer: boolean;
  /**
   * Stops the visit: no request is sent, no visit event fires, and the visit resolves `undefined` (like a guard's no). The
   * other listeners are still told — `cancelled` says it is stopped.
   */
  cancel(): void;
  readonly cancelled: boolean;
}

/**
 * A visit's answer with validation errors — `invalid`'s event: a page or a layer came back with its `errors` prop filled (the
 * server sent a form back). An action's 422 is not one: `useAction` hands its errors to its caller (`outcome.kind === 'invalid'`).
 */
export interface InvalidAnswer {
  /** The errors by field, as the server sent them (`{ email: ['…'] }`). */
  readonly errors: ValidationErrors;
  /** The visit's request URL (`/register`, a GET's data in its query). */
  readonly url: string;
  readonly method: VisitMethod;
  /** The route's name, when the visit named it (a route form). */
  readonly name: string | undefined;
}

/** The events of the hook API, by name — the listener's signature. */
export interface HookEvents {
  /**
   * Every visit of the navigator (`visit`, `reload`, a link, a form, a poll, a layer's) after its own `confirm` and before its
   * request — `event.cancel()` stops it. Not for Back/Forward, prefetches, deferred props, islands or actions: they are no visits.
   */
  before: (event: BeforeVisit) => void;
  /** A visit's answer brought validation errors (the page's or the layer's `errors` prop). */
  invalid: (event: InvalidAnswer) => void;
}

export type HookEvent = keyof HookEvents;

/** What the hook API offers: listen to an event — returns the function that stops listening. */
export interface ClientHooks {
  // The names written out: a wrong one reads `… is not assignable to parameter of type '"before" | "invalid"'`.
  on<E extends 'before' | 'invalid'>(event: E, listener: HookEvents[E]): () => void;
}

/** The `before` event of `visit`: `cancelled` follows `cancel()`. */
function beforeVisit(visit: PendingVisit): BeforeVisit {
  let cancelled = false;
  return {
    url: visit.target.href,
    method: visit.method,
    options: visit.options,
    layer: visit.layer,
    cancel: () => void (cancelled = true),
    get cancelled() {
      return cancelled;
    },
  };
}

/**
 * The hook API as a feature: `before` hangs on the visit pipeline first (order 0, before the guard asks about unsaved
 * changes — a visit an app stops asks nothing), `invalid` on the visits' `error` event.
 */
export const hooks = defineFeature(
  'hooks',
  (host: FeatureHost): ClientHooks => {
    const listeners: { [E in HookEvent]: Set<HookEvents[E]> } = { before: new Set(), invalid: new Set() };
    host.on('visit', (visit) => {
      if (listeners.before.size === 0) return undefined;
      const event = beforeVisit(visit);
      notify(listeners.before, event);
      return event.cancelled ? false : undefined;
    });
    host.navigator.on('error', (errors, visit) => notify(listeners.invalid, { errors, url: visit.url, method: visit.method, name: visit.name }));
    return {
      on: (event, listener) => {
        const set = listeners[event] as Set<typeof listener>;
        set.add(listener);
        return () => void set.delete(listener);
      },
    };
  },
  0,
);
