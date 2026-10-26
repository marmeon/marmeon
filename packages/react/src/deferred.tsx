import type { ReactNode } from 'react';
import { usePage, type PropName } from './app.tsx';

/** The props of {@link Deferred}: the deferred props to wait for, a `fallback` and the `children`. */
export interface DeferredProps<T = unknown> {
  /** The deferred prop(s) to wait for — names of props of page `T` (its controller), when given. */
  data: PropName<T> | readonly PropName<T>[];
  /** Shown until they are there (also in the server-rendered HTML). */
  fallback?: ReactNode;
  /** Shown once they are there — a function to render only then (it may use the props without checks). */
  children: ReactNode | (() => ReactNode);
}

/**
 * Renders `fallback` until the page's deferred props (`defer()` on the server) have arrived, then `children`. A revalidation of
 * the whole page (the reload after an action, a live update, a reload on Back) keeps the old values on screen until the new
 * ones land. See docs/deferred-props.md#deferred-props.
 */
export function Deferred<T = unknown>({ data, fallback = null, children }: DeferredProps<T>) {
  const { props } = usePage<Record<string, unknown>>();
  const names: readonly string[] = typeof data === 'string' ? [data] : (data as readonly string[]);
  const ready = names.every((name) => props[name] !== undefined);
  if (!ready) return <>{fallback}</>;
  return <>{typeof children === 'function' ? children() : children}</>;
}
