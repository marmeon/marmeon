import { describe, expect, it } from 'vitest';
import { PasswordHasher } from './index.ts';

// Wall-clock tests run alone and last (the `timing` project), so no other test competes for the CPU. A leak is a ratio of about
// 0.02 against the bound of 0.5; `hashing.test.ts` proves the same property by counting the work.
describe('the time of a check', () => {
  it('dummyVerify takes as long as a real verify (unknown e-mail ≈ wrong password)', async () => {
    const hasher = new PasswordHasher(); // real costs: differences must not hide in noise
    const hash = await hasher.make('secret');
    await hasher.dummyVerify('warm-up'); // the first call also makes its reference hash
    const real: number[] = [];
    const dummy: number[] = [];
    for (let i = 0; i < 7; i++) {
      let started = performance.now();
      await hasher.verify('wrong password', hash);
      real.push(performance.now() - started);
      started = performance.now();
      expect(await hasher.dummyVerify('wrong password')).toBe(false);
      dummy.push(performance.now() - started);
    }
    const ratio = median(dummy) / median(real);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
    // Without it, an unknown e-mail would answer in no time:
    expect(median(real)).toBeGreaterThan(5);
  });
});

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
