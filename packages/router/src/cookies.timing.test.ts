import { describe, expect, it } from 'vitest';
import { parseCookies } from './cookies.ts';

// Wall-clock tests run alone and last (the `timing` project), so no other test competes for the CPU. `cookies.test.ts` proves
// which blanks a name loses; here is only how long it takes.
describe('the time of parsing a Cookie header', () => {
  it('trims a cookie name with a long run of blanks inside in linear time', () => {
    // A regex that retries a trailing-blank match at every blank of a run another character follows is quadratic: 60 000 blanks
    // take seconds, against the bound of 2 s. Linear parsing takes a millisecond or two.
    const header = `x${' '.repeat(60_000)}y=1; ok=1`;
    const started = performance.now();
    const cookies = parseCookies(header);
    const elapsed = performance.now() - started;
    expect(Object.fromEntries(cookies)).toEqual({ ok: '1' });
    expect(elapsed).toBeLessThan(2000);
  });
});
