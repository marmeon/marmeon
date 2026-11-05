import { afterEach, describe, expect, it } from 'vitest';
import { endpoint, NamedTable, tableApp, type TableTestApp } from './__fixtures__/app.ts';

// Wall-clock tests run alone (the `timing` project). A long run of dots or spaces inside the name, text an app may take from a
// user, must not cost quadratic time.
let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('the cost of cleaning an export file name', () => {
  it.each([
    ['spaces', ' '],
    ['dots', '.'],
  ])('cleans a name with a long run of %s in the middle in a short time', async (_label, filler) => {
    open = await tableApp('sqlite');
    const name = `a${filler.repeat(1e5)}a`;
    const started = performance.now();
    const response = await open.request(endpoint(NamedTable, 'export', 'given'), { user: 1, headers: { 'x-test-name': encodeURIComponent(name) } });
    const elapsed = performance.now() - started;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('filename="a.csv"'); // cut to 100 code points, then the run at the end trimmed
    expect(elapsed).toBeLessThan(1000);
  });
});
