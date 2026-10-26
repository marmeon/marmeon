import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePage, useRouterContext, type PropName, type ReloadOptions } from './app.tsx';

export interface WhenVisibleProps<T = unknown> {
  /** The prop(s) to load once this is scrolled into view (`optional()` or `defer()` ones) — of page `T`, when given. */
  data?: PropName<T> | readonly PropName<T>[];
  /** The reload instead (or on top): `{ data: { cursor }, only: ['people'], preserveUrl: true }` for infinite scroll. */
  reload?: ReloadOptions<T>;
  /** Load this many pixels before it comes into view (default 0). */
  buffer?: number;
  /** Load again every time it comes into view (infinite scroll, with `merge()` props) — default once. */
  always?: boolean;
  /** The element that is watched (default `div`). */
  as?: string;
  /** Shown until the props are there — and, with `always`, while loading. */
  fallback?: ReactNode;
  /** Shown once they are there — a function to render only then (it may use the props without checks). */
  children?: ReactNode | (() => ReactNode);
}

/**
 * Loads props when this comes into view (IntersectionObserver; without one, right away), with a background reload (`async`).
 * See docs/deferred-props.md#props-loaded-when-seen, and docs/deferred-props.md#merged-props for infinite scroll (`always`).
 */
export function WhenVisible<T = unknown>(props: WhenVisibleProps<T>) {
  // `params` means route parameters everywhere else: passed here untyped, it would load nothing it asked for.
  if (Object.hasOwn(props, 'params')) throw new TypeError('<WhenVisible params> is <WhenVisible reload>.');
  return WhenVisibleBody(props);
}

function WhenVisibleBody<T>({ data, reload, buffer = 0, always = false, as = 'div', fallback = null, children }: WhenVisibleProps<T>) {
  const { props } = usePage<Record<string, unknown>>();
  const router = useRouterContext();
  const names: readonly string[] = data === undefined ? [] : typeof data === 'string' ? [data] : (data as readonly string[]);
  const ready = names.length > 0 && names.every((name) => props[name] !== undefined);
  const [loading, setLoading] = useState(false);
  const element = useRef<Element | null>(null);
  // Read when it comes into view: the reload of the latest render (the next cursor).
  const latest = useRef({ router, reload, names });
  latest.current = { router, reload, names };
  const done = ready && !always;

  useEffect(() => {
    if (done) return undefined;
    let busy = false;
    let observer: IntersectionObserver | undefined;
    let stopped = false;
    const load = () => {
      if (busy || stopped) return;
      busy = true;
      setLoading(true);
      const { router, reload, names } = latest.current;
      void router
        .reload({
          ...reload,
          only: (reload?.only ?? names) as ReloadOptions<T>['only'],
          async: true,
          onFinish: (visit) => {
            reload?.onFinish?.(visit);
            busy = false;
            if (stopped) return;
            setLoading(false);
            // Still in view (a short list)? Observing anew reports it again — and loads the next page.
            if (always && observer && element.current) {
              observer.unobserve(element.current);
              observer.observe(element.current);
            }
          },
        });
    };
    if (typeof IntersectionObserver === 'undefined' || !element.current) {
      load();
      return () => void (stopped = true);
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (!always) observer?.disconnect();
        load();
      },
      { rootMargin: `${buffer}px` },
    );
    observer.observe(element.current);
    return () => {
      stopped = true;
      observer?.disconnect();
    };
  }, [done, always, buffer]);

  // Once: the fallback until the props are there. Always: the children stay, the fallback shows while loading.
  const shown = ready || (always && names.length === 0);
  const content = shown ? (typeof children === 'function' ? children() : children) : null;
  return createElement(as, { ref: element }, content, (always ? loading : !ready) ? fallback : null);
}
