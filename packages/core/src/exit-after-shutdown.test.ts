import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from './application.ts';
import { exitAfterShutdown } from './exit-after-shutdown.ts';

describe('exitAfterShutdown', () => {
  afterEach(() => vi.useRealTimers());

  it('exits after the delay, and only once the app has shut down', async () => {
    vi.useFakeTimers();
    const app = { shuttingDown: true } as Application;
    const exit = vi.fn();
    exitAfterShutdown(app, 0, 2000, exit);
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).not.toHaveBeenCalled();
    (app as { shuttingDown: boolean }).shuttingDown = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits at the delay when the shutdown is over', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    exitAfterShutdown({ shuttingDown: false } as Application, 0, 2000, exit);
    await vi.advanceTimersByTimeAsync(1999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
