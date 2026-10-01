import type { ReactNode } from 'react';
import { usePage, type PropName } from './app.tsx';

export interface DeferredProps<T = unknown> {
  /** The deferred prop(s) to wait for — names of props of page `T` (its controller), when given. */
  data: PropName<T> | readonly PropName<T>[];
  /** Shown until they are there (also in the server-rendered HTML). */
  fallback?: ReactNode;
  /** Shown once they are there — a function to render only then (it may use the props without checks). */
  children: ReactNode | (() => ReactNode);
}

/**
 * Renders `fallback` until the page's deferred props (`defer()` on the server) have arrived, then `children`:
 *
 * ```tsx
 * <Deferred<ShowUserProfileController> data="activity" fallback={<p>Loading…</p>}>
 *   {() => <ActivityList items={activity!} />}
 * </Deferred>
 * ```
 *
 * The page renders without them, the browser loads them right after (one partial reload per group). A full
 * reload sends the page without them again — the fallback shows until they are back.
 */
export function Deferred<T = unknown>({ data, fallback = null, children }: DeferredProps<T>) {
  const { props } = usePage<Record<string, unknown>>();
  const names: readonly string[] = typeof data === 'string' ? [data] : (data as readonly string[]);
  const ready = names.every((name) => props[name] !== undefined);
  if (!ready) return <>{fallback}</>;
  return <>{typeof children === 'function' ? children() : children}</>;
}
