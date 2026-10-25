// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROGRESS_ATTRIBUTE, showProgress } from './progress.ts';

describe('progress bar', () => {
  /** A navigator's event source, driven by hand. */
  function events() {
    const listeners = new Map<string, Set<(...args: never[]) => void>>();
    return {
      on: ((event: string, listener: (...args: never[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
        return () => listeners.get(event)!.delete(listener);
      }) as never,
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) (listener as (...args: unknown[]) => void)(...args);
      },
    };
  }
  const bar = () => document.querySelector<HTMLElement>(`[${PROGRESS_ATTRIBUTE}]`);
  const visit = { url: '/b', method: 'get' };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('names the unit of its delay', () => {
    // @ts-expect-error -- the option is delayMs
    showProgress(events(), { delay: 250 })();
  });

  it('appears only for visits slower than the delay, and goes away when they finish', () => {
    const source = events();
    const stop = showProgress(source, { delayMs: 250 });

    source.emit('start', visit);
    vi.advanceTimersByTime(200);
    source.emit('finish', visit);
    vi.advanceTimersByTime(1000);
    expect(bar()).toBeNull(); // fast: never shown

    source.emit('start', visit);
    vi.advanceTimersByTime(300);
    expect(bar()).not.toBeNull();
    expect(bar()!.style.background).toContain('--marmeon-progress-color');
    source.emit('progress', { loaded: 50, total: 100, percentage: 50 }, visit);
    expect(bar()!.style.transform).toBe('scaleX(0.45)');
    source.emit('finish', visit);
    vi.advanceTimersByTime(1000);
    expect(bar()).toBeNull();
    stop();
  });

  it('stays while any request runs (a cancelled one finishing does not end the newer one)', () => {
    const source = events();
    const stop = showProgress(source, { delayMs: 0 });
    source.emit('start', visit);
    source.emit('start', visit);
    vi.advanceTimersByTime(10);
    source.emit('cancel', visit);
    source.emit('finish', visit);
    vi.advanceTimersByTime(1000);
    expect(bar()).not.toBeNull();
    source.emit('finish', visit);
    vi.advanceTimersByTime(1000);
    expect(bar()).toBeNull();
    stop();
  });
});
