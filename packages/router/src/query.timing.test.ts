import { describe, expect, it } from 'vitest';
import { queryInput } from './request-definition.ts';

// Wall-clock tests run alone and last (the `timing` project), so no other test competes for the CPU. `query.test.ts` proves what
// a repeated key yields; here is only how long it takes.
describe('the time of reading a query', () => {
  it('reads a repeated key as a list in linear time', () => {
    // Copying the list at each of 200 000 repeats is 2·10¹⁰ element copies, many seconds against the bound of 1 s.
    const count = 200_000;
    const started = performance.now();
    const input = queryInput(new URLSearchParams('tag=x&'.repeat(count)));
    expect(input.tag).toHaveLength(count);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
