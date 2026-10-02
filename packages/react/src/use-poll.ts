import { createPoll, type Poll } from '@bespokecore/http/client';
import { useEffect, useMemo, useRef } from 'react';
import { useRouterContext, type ReloadOptions } from './app.tsx';

export interface UsePollOptions {
  /** Keep polling while the tab is hidden (default: pause, and catch up when it is shown again). */
  keepAlive?: boolean;
  /** Start right away (default) — or later, with `start()`. */
  autoStart?: boolean;
}

/**
 * Reloads the page every `interval` ms while it is mounted — in the background (`async`: no progress bar, it
 * cancels no visit and lands only on the page it was for), paused while the tab is hidden, stopped on unmount:
 *
 * ```ts
 * usePoll<ShowUserProfileController>(15_000, { only: ['activity'] });   // the prop names are checked
 * ```
 */
export function usePoll<T = unknown>(interval: number, options: ReloadOptions<T> = {}, { keepAlive = false, autoStart = true }: UsePollOptions = {}): Pick<Poll, 'start' | 'stop'> {
  const router = useRouterContext();
  // The latest options and router, read on every turn: an inline object does not restart the poll.
  const latest = useRef({ router, options });
  latest.current = { router, options };

  const poll = useMemo(
    () => (typeof window === 'undefined' ? undefined : createPoll(() => latest.current.router.reload({ ...latest.current.options, async: true }), interval, { keepAlive })),
    [interval, keepAlive],
  );
  useEffect(() => {
    if (autoStart) poll?.start();
    return () => poll?.stop();
  }, [poll, autoStart]);

  return useMemo(() => ({ start: () => poll?.start(), stop: () => poll?.stop() }), [poll]);
}
