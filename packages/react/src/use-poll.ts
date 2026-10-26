import { createPoll, type Poll } from '@marmeon/http/client';
import { useEffect, useMemo, useRef } from 'react';
import { useRouterContext, type ReloadOptions } from './app.tsx';

export interface UsePollOptions {
  /** Milliseconds between two reloads: above 0, up to 2147483647 (the longest a timer holds). */
  intervalMs: number;
  /** Keep polling while the tab is hidden (default: pause, and catch up when it is shown again). */
  keepAlive?: boolean;
  /** Start right away (default) — or later, with `start()`. */
  autoStart?: boolean;
}

/**
 * Reloads the page every `intervalMs` ms (an option) while it is mounted — in the background (`async`: no progress bar, it
 * cancels no visit and lands only on the page it was for), paused while the tab is hidden, stopped on unmount:
 *
 * ```ts
 * usePoll<ShowUserProfileController>({ intervalMs: 15_000 }, { only: ['activity'] });   // the prop names are checked
 * ```
 */
export function usePoll<T = unknown>(pollOptions: UsePollOptions, options: ReloadOptions<T> = {}): Pick<Poll, 'start' | 'stop'> {
  if (typeof pollOptions !== 'object' || pollOptions === null || typeof options !== 'object' || options === null) {
    throw new TypeError('usePoll({ intervalMs }, reloadOptions) takes its interval in the first argument, not as a number.');
  }
  const { intervalMs, keepAlive = false, autoStart = true } = pollOptions;
  // The same rule as `createPoll`, here too so that a bad value fails on the server as well as at hydration.
  if (!(Number.isFinite(intervalMs) && intervalMs > 0 && intervalMs <= 2_147_483_647)) {
    throw new RangeError(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? `[marmeon:C5] A poll needs an interval above 0 and up to 2147483647 ms, got ${intervalMs}.` : `[marmeon:C5] ${intervalMs}`);
  }
  const router = useRouterContext();
  // The latest options and router, read on every turn: an inline object does not restart the poll.
  const latest = useRef({ router, options });
  latest.current = { router, options };

  const poll = useMemo(
    () => (typeof window === 'undefined' ? undefined : createPoll(() => latest.current.router.reload({ ...latest.current.options, async: true }), { intervalMs, keepAlive })),
    [intervalMs, keepAlive],
  );
  useEffect(() => {
    if (autoStart) poll?.start();
    return () => poll?.stop();
  }, [poll, autoStart]);

  return useMemo(() => ({ start: () => poll?.start(), stop: () => poll?.stop() }), [poll]);
}
