import { createApplication } from '@marmeon/core';
import { BROWSER_LOG_EVENT } from '@marmeon/http/protocol';
import { channels, type BrowserLogMessage } from '@marmeon/core/diagnostics';
import { describe, expect, it } from 'vitest';
import { acceptBrowserLog, BrowserLogLimiter } from './browser-log.ts';
import { listenForBrowserLogs } from './vite.ts';

const valid = { kind: 'console', level: 'error', message: 'It broke', page: '/notes?page=2' };

describe('acceptBrowserLog', () => {
  it('copies a valid report with its optional fields', () => {
    const report = { ...valid, kind: 'error', stack: 'Error: x\n    at a.js:1:1', source: { url: 'http://localhost/a.js', line: 3, column: 9 }, requestId: 'req_1.a:b-c' };
    expect(acceptBrowserLog(report)).toEqual(report);
    expect(acceptBrowserLog(valid)).toEqual(valid);
  });

  it('leaves out every key it does not know — also a `dropped` the page claims', () => {
    expect(acceptBrowserLog({ ...valid, dropped: 9999, app: 'x', startedAt: 1, jobId: 'j', __proto__: { polluted: true }, extra: { deep: 1 } })).toEqual(valid);
  });

  it('refuses a wrong kind or level, and a field of the wrong type', () => {
    for (const bad of [
      { ...valid, kind: 'log' },
      { ...valid, kind: undefined },
      { ...valid, level: 'info' },
      { ...valid, level: 'debug' },
      { ...valid, message: 7 },
      { ...valid, message: undefined },
      { ...valid, page: undefined },
      { ...valid, stack: { text: 'x' } },
      { ...valid, source: 'a.js' },
      { ...valid, source: { url: 'a.js', line: '3', column: 1 } },
      { ...valid, source: { url: 'a.js', line: -1, column: 1 } },
      { ...valid, source: { url: 'a.js', line: 1.5, column: 1 } },
      { ...valid, source: { url: 7, line: 1, column: 1 } },
    ]) {
      expect(acceptBrowserLog(bad), JSON.stringify(bad)).toBeUndefined();
    }
    for (const bad of [undefined, null, 'text', 7, [valid], () => valid]) expect(acceptBrowserLog(bad)).toBeUndefined();
  });

  it('cuts strings that are too long instead of refusing the report', () => {
    const accepted = acceptBrowserLog({ ...valid, message: 'm'.repeat(10_000), stack: 's'.repeat(40_000), page: 'p'.repeat(5000), source: { url: 'u'.repeat(5000), line: 1, column: 1 } })!;
    expect([accepted.message.length, accepted.stack!.length, accepted.page.length, accepted.source!.url.length]).toEqual([4096, 16_384, 2048, 2048]);
  });

  it('strips control characters, line separators and escape sequences from every text, keeping newlines and tabs', () => {
    const osc = '\x1b]8;;http://evil.example\x07click\x1b]8;;\x07';
    const accepted = acceptBrowserLog({ ...valid, message: 'a\x1b[2Jb\0\r\x85\u2028c\u2029d\x7f', stack: `at x\n\tat ${osc}`, page: `/p${osc}`, source: { url: `u${osc}`, line: 1, column: 1 } })!;
    expect(accepted.message).toBe('a[2Jbcd');
    expect(accepted.stack).toBe('at x\n\tat ]8;;http://evil.exampleclick]8;;');
    expect(accepted.page).toBe('/p]8;;http://evil.exampleclick]8;;');
    expect(accepted.source!.url).toBe('u]8;;http://evil.exampleclick]8;;');
    // oxlint-disable-next-line no-control-regex -- asserting that no control character is left
    const controls = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/;
    for (const text of [accepted.message, accepted.stack, accepted.page, accepted.source!.url]) expect(text).not.toMatch(controls);
  });

  it('drops a requestId that is not a request id, keeps the report', () => {
    for (const requestId of ['', 'a b', 'a/b', '<script>', 'x'.repeat(129), 'ok\nline', 7, {}]) {
      expect(acceptBrowserLog({ ...valid, requestId }), String(requestId)).toEqual(valid);
    }
    expect(acceptBrowserLog({ ...valid, requestId: 'x'.repeat(128) })!.requestId).toHaveLength(128);
  });
});

describe('BrowserReport', () => {
  it('has no `dropped`: the limiter says it, not the page', () => {
    const report = acceptBrowserLog(valid)!;
    // @ts-expect-error `dropped` belongs to the server
    expect(report.dropped).toBeUndefined();
  });
});

describe('BrowserLogLimiter', () => {
  it('lets a burst of 50 through, holds the rest back, and the next report after a refill carries the count', () => {
    const limiter = new BrowserLogLimiter();
    let passed = 0;
    for (let i = 0; i < 200; i++) if (limiter.take(1000)) passed++;
    expect(passed).toBe(50);
    expect(limiter.take(1000)).toBeUndefined();
    // 10 a second: 100 ms is one report.
    expect(limiter.take(1100)).toEqual({ dropped: 151 });
    limiter.reported();
    expect(limiter.take(1100)).toBeUndefined();
    expect(limiter.take(1200)).toEqual({ dropped: 1 });
  });

  it('keeps the count until a report carried it', () => {
    const limiter = new BrowserLogLimiter();
    for (let i = 0; i < 53; i++) limiter.take(0);
    expect(limiter.take(100)).toEqual({ dropped: 3 });
    // Not reported (malformed, or nobody listens): the next one still says 3.
    expect(limiter.take(200)).toEqual({ dropped: 3 });
    limiter.reported();
    expect(limiter.take(300)).toEqual({ dropped: 0 });
  });

  it('refills at most to the burst', () => {
    const limiter = new BrowserLogLimiter();
    for (let i = 0; i < 50; i++) limiter.take(0);
    let passed = 0;
    for (let i = 0; i < 100; i++) if (limiter.take(3_600_000)) passed++;
    expect(passed).toBe(50);
  });
});

describe('listenForBrowserLogs', () => {
  /** A stand-in for Vite's HMR channel: what the page sends arrives at `emit`, from a client object. */
  function fakeHot() {
    const listeners = new Map<string, (data: unknown, client: object) => void>();
    return { hot: { on: (event: string, listener: (data: unknown, client: object) => void) => void listeners.set(event, listener) }, listeners };
  }

  async function setup() {
    const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [] }, { env: { NODE_ENV: 'test' } });
    const seen: BrowserLogMessage[] = [];
    const off = channels.subscribe(app, 'browser.log', (message) => void seen.push(message));
    const { hot, listeners } = fakeHot();
    // The limiters' clock is the test's: time passes only when it says so.
    const clock = { now: 1000 };
    listenForBrowserLogs(app, hot, () => clock.now);
    return { app, seen, clock, send: (data: unknown, client: object) => listeners.get(BROWSER_LOG_EVENT)!(data, client), off, listeners };
  }

  it('publishes a checked report on browser.log, for the app', async () => {
    const { app, seen, send, off, listeners } = await setup();
    send({ ...valid, requestId: 'req-1', extra: 1 }, {});
    off();
    expect([...listeners.keys()]).toEqual([BROWSER_LOG_EVENT]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ app, ...valid, requestId: 'req-1' });
    expect(seen[0]).not.toHaveProperty('extra');
    expect(seen[0]).not.toHaveProperty('dropped');
    expect(typeof seen[0]!.startedAt).toBe('number');
  });

  it('publishes nothing for a malformed report', async () => {
    const { seen, send, off } = await setup();
    for (const bad of [null, 'x', { ...valid, kind: 'nope' }, { ...valid, message: 1 }]) send(bad, {});
    off();
    expect(seen).toEqual([]);
  });

  it('holds 200 reports in one tick to 50, and the next one after the refill says how many it missed', async () => {
    const { seen, clock, send, off } = await setup();
    const client = {};
    for (let i = 0; i < 200; i++) send({ ...valid, message: `n${i}` }, client);
    expect(seen).toHaveLength(50);
    expect(seen.every((message) => message.dropped === undefined)).toBe(true);
    clock.now += 100;
    send({ ...valid, message: 'after' }, client);
    off();
    expect(seen).toHaveLength(51);
    expect(seen[50]).toMatchObject({ message: 'after', dropped: 150 });
  });

  it('gives each client its own budget', async () => {
    const { seen, send, off } = await setup();
    const [first, second] = [{}, {}];
    for (let i = 0; i < 80; i++) send(valid, first);
    for (let i = 0; i < 80; i++) send(valid, second);
    off();
    expect(seen).toHaveLength(100);
  });

  it('does not lose the missed count when the report that could have carried it is malformed', async () => {
    const { seen, clock, send, off } = await setup();
    const client = {};
    for (let i = 0; i < 53; i++) send(valid, client);
    clock.now += 100;
    send({ ...valid, kind: 'nope' }, client);
    clock.now += 100;
    send({ ...valid, message: 'next' }, client);
    off();
    expect(seen.at(-1)).toMatchObject({ message: 'next', dropped: 3 });
  });

  it('holds all clients together to 200 at once — more sockets are not more budget', async () => {
    const { seen, send, off } = await setup();
    for (let client = 0; client < 10; client++) for (let i = 0; i < 50; i++) send(valid, {});
    off();
    expect(seen).toHaveLength(200);
  });

  it('tells the client whose reports the shared budget held back, once it can send again', async () => {
    const { seen, clock, send, off } = await setup();
    for (let client = 0; client < 5; client++) for (let i = 0; i < 50; i++) send(valid, {});
    const late = {};
    send(valid, late);
    expect(seen).toHaveLength(200);
    clock.now += 100;
    send({ ...valid, message: 'later' }, late);
    off();
    expect(seen.at(-1)).toMatchObject({ message: 'later', dropped: 1 });
  });
});
