import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '@marmeon/core';
import { shutDown } from './shut-down.ts';

const app = (stuck: string[]) => ({ shutdown: async () => {}, stuckProviders: stuck }) as unknown as Application;

describe('shutDown', () => {
  afterEach(() => {
    vi.useRealTimers();
    process.exitCode = undefined;
  });

  it('forces the exit two seconds after a provider timed out, with 1 when the command ended with 0', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    await shutDown(app(['Stuck']), exit);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps the command's own failure code", async () => {
    vi.useFakeTimers();
    process.exitCode = 2;
    const exit = vi.fn();
    await shutDown(app(['Stuck']), exit);
    await vi.advanceTimersByTimeAsync(2000);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('forces nothing when every provider stopped in time', async () => {
    vi.useFakeTimers();
    await shutDown(app([]), () => {
      throw new Error('exited');
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
