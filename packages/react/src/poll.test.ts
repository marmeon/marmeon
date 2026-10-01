import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoll, type PollDocument } from './poll.ts';

/** A tab that can be sent to the background — `visibilitychange` as the browser fires it. */
class FakeDocument implements PollDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  readonly #listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void) {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void) {
    this.#listeners.delete(listener);
  }

  get listeners() {
    return this.#listeners.size;
  }

  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    for (const listener of this.#listeners) listener();
  }
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('createPoll', () => {
  it('runs every interval — one at a time, the next one an interval after the last one finished', async () => {
    const document = new FakeDocument();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const poll = createPoll(run, 1000, { document });
    poll.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // a slow turn: no second one meanwhile
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it('counter-check: pauses while the tab is hidden — and catches up when it is shown again', async () => {
    const document = new FakeDocument();
    const run = vi.fn(async () => {});
    const poll = createPoll(run, 1000, { document });
    poll.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    document.set('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1); // nothing while nobody looks

    document.set('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2); // a turn was missed: right away
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);

    // Hidden and back before the turn is due: it keeps its time.
    await vi.advanceTimersByTimeAsync(400);
    document.set('hidden');
    document.set('visible');
    await vi.advanceTimersByTimeAsync(599);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(4);
    poll.stop();
  });

  it('starts paused in a hidden tab; keepAlive polls in the background too', async () => {
    const document = new FakeDocument();
    document.visibilityState = 'hidden';
    const run = vi.fn(async () => {});
    const paused = createPoll(run, 1000, { document });
    paused.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    paused.stop();

    const alive = createPoll(run, 1000, { document, keepAlive: true });
    alive.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(3);
    alive.stop();
  });

  it('stops: no more turns, the listener is gone — and a failed turn does not end the poll', async () => {
    const document = new FakeDocument();
    const run = vi.fn(async () => {
      throw new Error('offline');
    });
    const poll = createPoll(run, 1000, { document });
    poll.start();
    expect(document.listeners).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(2);
    poll.stop();
    expect(poll.running).toBe(false);
    expect(document.listeners).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(() => createPoll(run, 0)).toThrow('A poll needs an interval above 0 ms, got 0.');
  });
});
