import { describe, expect, it } from 'vitest';
import { createRequestState } from './request.ts';

// Wall-clock tests run alone and last (the `timing` project), so no other test competes for the CPU. `request.test.ts` proves
// what a huge list yields; here is only how long it takes.
describe('the time of parsing a body', () => {
  it('parses a huge list of `a[]` items in linear time — forms and multipart alike', async () => {
    const count = 50_000; // the body limit (8 MiB) holds this much
    const expected = Array.from({ length: count }, (_, index) => `v${index}`);
    const multipart = new FormData();
    for (const value of expected) multipart.append('a[]', value);
    const urlencoded = new Request('http://app.test/', { method: 'POST', body: expected.map((value) => `a[]=${value}`).join('&'), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const multiparted = new Request('http://app.test/', { method: 'POST', body: multipart });

    const started = performance.now();
    const fromForm = await createRequestState(urlencoded).input();
    const fromMultipart = await createRequestState(multiparted).input();
    const elapsed = performance.now() - started;
    expect(fromForm).toEqual({ a: expected });
    expect(fromMultipart).toEqual({ a: expected });
    // Looking through the earlier items for each one is 1.25·10⁹ steps: seconds, against the bound of 3 s.
    expect(elapsed).toBeLessThan(3000);
  });
});
