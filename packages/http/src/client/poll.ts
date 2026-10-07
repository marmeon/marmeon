/**
 * Polling, UI-free (part of the client core — `usePoll` of @marmeon/react builds on it): runs `run` every `interval` ms — one at a time, the
 * next one `interval` after the last one finished — and pauses while the tab is in the background.
 */

/** The parts of `document` a poll uses (a fake one in tests). */
export interface PollDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface PollOptions {
  /** Keep polling while the tab is hidden (default: pause, and catch up when it is shown again). */
  keepAlive?: boolean;
  /** Default: the browser's `document`. */
  document?: PollDocument;
}

export interface Poll {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * Polls with `run` (a background reload): paused while `document.visibilityState` is `hidden` — nobody looks, and
 * browsers throttle background timers anyway — and on coming back, it polls right away if a turn was missed.
 */
export function createPoll(run: () => Promise<unknown>, interval: number, { keepAlive = false, document = globalThis.document }: PollOptions = {}): Poll {
  if (!(interval > 0)) {
    throw new RangeError(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? `[marmeon:C5] A poll needs an interval above 0 ms, got ${interval}.` : `[marmeon:C5] ${interval}`);
  }
  let running = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the last turn started (or the poll did): what a tab coming back measures against. */
  let last = 0;

  const paused = () => !keepAlive && document?.visibilityState === 'hidden';

  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delay: number) => {
    clear();
    timer = setTimeout(tick, Math.max(0, delay));
  };

  const tick = async () => {
    timer = undefined;
    if (!running || paused()) return;
    inFlight = true;
    last = Date.now();
    try {
      await run();
    } catch {
      // A failed turn is reported by the request itself (an `exception` event); the next one tries again.
    } finally {
      inFlight = false;
    }
    if (running && !paused()) schedule(interval);
  };

  const onVisibility = () => {
    if (!running) return;
    if (paused()) clear();
    else if (timer === undefined && !inFlight) schedule(interval - (Date.now() - last));
  };

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      last = Date.now();
      document?.addEventListener('visibilitychange', onVisibility);
      if (!paused()) schedule(interval);
    },
    stop() {
      running = false;
      clear();
      document?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
