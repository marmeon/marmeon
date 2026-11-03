import { describe, expect, it } from 'vitest';
import { HttpError } from './errors.ts';
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

  it('refuses a field name nested past the limit without building all its levels', async () => {
    // As many levels as the body limit (8 MiB) holds. Building a match for each before counting them takes seconds and
    // hundreds of megabytes, against the bound of 400 ms.
    const body = `a${'[]'.repeat(Math.floor((8 * 1024 * 1024 - 3) / 2))}=1`;
    const request = new Request('http://app.test/', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });

    const started = performance.now();
    const rejected = await createRequestState(request).input().then(() => undefined, (error: unknown) => error);
    const elapsed = performance.now() - started;
    expect(rejected).toBeInstanceOf(HttpError);
    expect((rejected as HttpError).status).toBe(400);
    expect(elapsed).toBeLessThan(400);
  });
});
