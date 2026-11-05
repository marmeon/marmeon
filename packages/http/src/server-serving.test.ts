import { describe, expect, it, vi } from 'vitest';
import { ServerServing } from './server-closing.ts';

describe('ServerServing — what runs before the process takes requests', () => {
  it('a callback that never finishes does not hold the start: begin() settles and says which deadline passed', async () => {
    const serving = new ServerServing();
    serving.deadlineMs = 20;
    serving.onServe(() => new Promise<void>(() => {}));
    const slow = vi.fn();
    await serving.begin(slow);
    expect(slow).toHaveBeenCalledWith(20);
  });

  it('a callback that throws stops the start', async () => {
    const serving = new ServerServing();
    serving.onServe(() => {
      throw new Error('refused');
    });
    await expect(serving.begin()).rejects.toThrow('refused');
  });

  it('a callback that finishes in time is not reported as slow, and each is told its deadline', async () => {
    const serving = new ServerServing();
    serving.deadlineMs = 50;
    const told: number[] = [];
    serving.onServe((deadlineMs) => void told.push(deadlineMs));
    serving.onServe(async () => {});
    const slow = vi.fn();
    await serving.begin(slow);
    expect(slow).not.toHaveBeenCalled();
    expect(told).toEqual([50]);
  });
});
