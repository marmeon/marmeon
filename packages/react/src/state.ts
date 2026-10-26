import type { NavigationGuard } from '@marmeon/http/client/adapter';
import { guard as guardFeature } from '@marmeon/http/client/adapter';
import type { BrowserRouteNameInput, CheckBrowserRouteName } from '@marmeon/http/page';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouterContext } from './app.tsx';

/** How long `usePending(name, { delay: 'short' })` waits before it says so — a fast request shows nothing (ms). */
export const SHORT_PENDING_DELAY_MS = 150;

/** Say so only once the request has taken this long, so a fast one shows no flicker: `delay: 'short'` (150 ms) or `delayMs` (ms). Default: at once. Give one of them. */
export type UsePendingOptions = { delay?: 'short'; delayMs?: never } | { delay?: never; delayMs?: number };

const noSubscription = () => () => {};

/**
 * Whether a request of route `name` is under way — a visit (`<Link route>`, a route form) or an action of any component:
 * for a spinner, `data-pending`, a disabled button. Checked against the routes the browser knows.
 *
 * ```tsx
 * const saving = usePending('user-profile.update', { delay: 'short' });
 * <button disabled={saving} data-pending={saving || undefined}>Save</button>
 * ```
 */
export function usePending<const N extends BrowserRouteNameInput>(name: CheckBrowserRouteName<N>, { delay, delayMs = 0 }: UsePendingOptions = {}): boolean {
  const navigator = useRouterContext().navigator();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!navigator) return () => {};
      // Visits, and what features have under way (actions): `isPending` reads both.
      return navigator.subscribeVisiting(listener);
    },
    [navigator],
  );
  const pending = useSyncExternalStore(navigator ? subscribe : noSubscription, () => navigator?.isPending(name) ?? false, () => false);
  const wait = delay === 'short' ? SHORT_PENDING_DELAY_MS : delayMs;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!pending || wait <= 0) {
      setLate(false);
      return undefined;
    }
    const timer = setTimeout(() => setLate(true), wait);
    return () => clearTimeout(timer);
  }, [pending, wait]);
  return wait <= 0 ? pending : pending && late;
}

/**
 * @internal A navigation guard of this component while `when` holds — on the page, or on the layer it is rendered in. Returns
 * its handle (the same object for the component's life): a form passes its own guard when it is sent.
 */
export function useGuard(when: boolean, message: string | undefined): NavigationGuard {
  const router = useRouterContext();
  const navigator = router.navigator();
  const latest = useRef(message);
  latest.current = message;
  const layer = router.layer;
  const guard = useRef<NavigationGuard | null>(null);
  if (guard.current === null || guard.current.layer !== (layer ?? undefined)) {
    guard.current = {
      get message() {
        return latest.current;
      },
      ...(layer ? { layer } : {}),
    };
  }
  const handle = guard.current;
  // The guard feature attaches with the first guard that holds — static here: a guard loaded later could not stop a
  // navigation that came first.
  useEffect(() => (when && navigator ? navigator.use(guardFeature).add(handle) : undefined), [when, navigator, handle]);
  return handle;
}

/** What `useBlocker()` takes: when to guard and what to ask. See docs/navigation.md#leaving-with-unsaved-changes. */
export interface UseBlockerOptions {
  /** Guard while this holds — unsaved changes: `when: form.isDirty()`. */
  when: boolean;
  /** What to ask (default: "You have unsaved changes. Leave anyway?"). The browser's own question on closing the tab has its own words. */
  message?: string;
}

/**
 * The navigation guard: while `when` holds, leaving asks first through the app's dialog; closing the tab or reloading gets
 * the browser's own question. The full page load of a sign-in or a sign-out is never stopped. See
 * docs/navigation.md#leaving-with-unsaved-changes.
 *
 * ```tsx
 * const form = useForm('user-profile.update', { name, bio }, { params: { user } });
 * useBlocker({ when: form.isDirty(), message: t('forms.unsaved') });     // or useForm(…, { guard: true })
 * ```
 */
export function useBlocker({ when, message }: UseBlockerOptions): void {
  useGuard(when, message);
}

/** A new build waiting to load — from `useNewVersion()`. */
export interface NewVersion {
  /** Where the postponed full load goes. */
  readonly location: string;
  /** Loads it now (a full load). */
  reload(): void;
}

/**
 * A new build of the app that waits to load — set once its full load was postponed: the app's `version` listener
 * prevented it (`router.on('version', (event) => event.preventDefault())`), or unsaved changes kept it (the guard's question
 * answered "stay"). For a "a new version is available — reload" banner; undefined while none waits. The next visit loads it anyway.
 */
export function useNewVersion(): NewVersion | undefined {
  const navigator = useRouterContext().navigator();
  const location = useSyncExternalStore(
    navigator ? (listener) => navigator.subscribeNewVersion(listener) : noSubscription,
    () => navigator?.newVersion,
    () => undefined,
  );
  return location === undefined || !navigator ? undefined : { location, reload: () => navigator.reloadForNewVersion() };
}
