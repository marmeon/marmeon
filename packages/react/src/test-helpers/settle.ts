import { act } from 'react';
import { vi } from 'vitest';

/** Below the 5 s a test may take, so a wait that never succeeds fails with its last assertion, not with the test's timeout. */
const LIMIT = 4_000;

/** Lets the promises and effects that are already under way finish inside `act`. */
export const flush = () => act(async () => {});

/** Flushes React until `check` stops throwing — a step waits for the state it asserts on, not for a time. */
export const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await flush();
      check();
    },
    { timeout: LIMIT },
  );

/** `until` for a test outside `act` (view transitions, hydration outside the act environment). */
export const untilOutsideAct = (check: () => void) => vi.waitFor(check, { timeout: LIMIT });
