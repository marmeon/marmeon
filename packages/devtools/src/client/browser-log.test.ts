// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBrowserLog, type BrowserLogTarget, type BrowserReport } from './browser-log.ts';

/** A window of its own: console methods that count, and the listeners the hook adds. */
function page() {
  const listeners = new Map<string, (event: never) => void>();
  const listen = (type: string, listener: unknown) => void listeners.set(type, listener as (event: never) => void);
  const calls = { error: [] as unknown[][], warn: [] as unknown[][] };
  const target = {
    console: { error: (...args: unknown[]) => void calls.error.push(args), warn: (...args: unknown[]) => void calls.warn.push(args) },
    addEventListener: listen,
    removeEventListener: (type: string) => void listeners.delete(type),
  } as unknown as BrowserLogTarget;
  const fire = (type: string, event: object) => listeners.get(type)!(event as never);
  return { target, calls, listeners, fire };
}

const context = { requestId: 'req-1', page: () => '/lab?x=1' };

describe('installBrowserLog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('console.error: the original runs with its arguments, and the report is a console report with the page and request', () => {
    const { target, calls } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    target.console.error('x', { a: 1 });
    expect(calls.error).toEqual([['x', { a: 1 }]]);
    expect(sent).toEqual([{ kind: 'console', level: 'error', message: 'x { a: 1 }', page: '/lab?x=1', requestId: 'req-1' }]);
  });

  it('console.warn is kept apart by its level; an Error argument brings its stack', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), { page: () => '/' });
    const error = new Error('boom');
    target.console.warn('careful', error);
    expect(sent[0]).toMatchObject({ kind: 'console', level: 'warn', stack: error.stack });
    expect(sent[0]).not.toHaveProperty('requestId');
  });

  it('an uncaught error: message, the stack and where it was raised', () => {
    const { target, fire } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    const error = new TypeError('nope');
    fire('error', { message: 'Uncaught TypeError: nope', filename: 'https://app.test/a.js', lineno: 3, colno: 9, error });
    expect(sent).toEqual([{ kind: 'error', level: 'error', message: 'Uncaught TypeError: nope', stack: error.stack, source: { url: 'https://app.test/a.js', line: 3, column: 9 }, page: '/lab?x=1', requestId: 'req-1' }]);
  });

  it('an error without a location leaves out the source, not the report', () => {
    const { target, fire } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    fire('error', { message: 'Script error.', filename: '', lineno: 0, colno: 0 });
    expect(sent[0]).toMatchObject({ kind: 'error', message: 'Script error.' });
    expect(sent[0]).not.toHaveProperty('source');
  });

  it('an unhandled rejection: an Error gives name, message and stack; anything else is formatted', () => {
    const { target, fire } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    const error = new RangeError('too far');
    fire('unhandledrejection', { reason: error });
    fire('unhandledrejection', { reason: 'plain text' });
    fire('unhandledrejection', { reason: { code: 7 } });
    expect(sent.map(({ kind, message }) => [kind, message])).toEqual([
      ['rejection', 'RangeError: too far'],
      ['rejection', 'plain text'],
      ['rejection', '{ code: 7 }'],
    ]);
    expect(sent[0]!.stack).toBe(error.stack);
  });

  it('a send that throws, or one that logs, does not report itself again — the original runs exactly once', () => {
    const { target, calls } = page();
    let sends = 0;
    installBrowserLog(
      target,
      () => {
        sends++;
        target.console.error('while sending');
        throw new Error('channel closed');
      },
      context,
    );
    expect(() => target.console.error('first')).not.toThrow();
    expect(calls.error).toEqual([['first'], ['while sending']]);
    expect(sends).toBe(1);
  });

  it('a throwing original keeps its behaviour — the error reaches the caller, nothing is reported', () => {
    const { target } = page();
    target.console.warn = () => {
      throw new Error('original');
    };
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    expect(() => target.console.warn('x')).toThrow('original');
  });

  it('a cyclic object is `[Circular]`; a getter that throws or a hostile proxy blanks only that argument', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const getter = Object.defineProperty({}, 'bad', { enumerable: true, get: () => { throw new Error('getter'); } });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
    expect(() => target.console.error('Checkout failed', getter, proxy, cyclic)).not.toThrow();
    expect(sent[0]!.message).toBe('Checkout failed [unprintable] [unprintable] { name: "loop", self: [Circular] }');
  });

  it('a wide, deep, shared structure is written within a bounded number of steps and about the limit in text', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    let reads = 0;
    // Four levels, 50 wide, every level the same children again (shared, not cyclic): 50^3 leaves if expanded in full.
    const counted = <T extends object>(value: T): T => new Proxy(value, { get: (object, key) => (reads++, Reflect.get(object, key)) });
    const leaf = counted(Array.from({ length: 50 }, (_, index) => index));
    const level = (child: unknown[]) => counted(Array.from({ length: 50 }, () => child));
    const wide = level(level(level(leaf)));
    target.console.error(wide);
    expect(sent[0]!.message.length).toBeLessThanOrEqual(4096);
    expect(sent[0]!.message.endsWith('…') || sent[0]!.message.includes('…')).toBe(true);
    expect(reads).toBeLessThan(5000);
  });

  it('a typed array is read by index and capped like an array, not turned into a string per element', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    let keys = 0;
    const spy = vi.spyOn(Object, 'keys').mockImplementation(((value: object) => (keys++, Reflect.ownKeys(value).filter((key) => typeof key === 'string'))) as typeof Object.keys);
    target.console.error(new Uint8ClampedArray(3.3e7));
    spy.mockRestore();
    expect(keys).toBe(0);
    expect(sent[0]!.message).toMatch(/^\[ 0(, 0){49}, … 32999950 more \]$/);
  });

  it('a long key is cut and charged to the budget', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    const read: string[] = [];
    const object = new Proxy({ ['k'.repeat(5e6)]: 1, second: 2 }, { get: (target, key) => (read.push(String(key).slice(0, 6)), Reflect.get(target, key)) });
    target.console.error(object);
    expect(sent[0]!.message.length).toBeLessThanOrEqual(4096);
    // The key used the whole budget: nothing after it is read.
    expect(read).toEqual(['kkkkkk']);
  });

  it('% specifiers are filled (%s %d %i %f %o %O), %c goes with its argument, %% is one %, the rest follows', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    target.console.error('Warning: %s of %s is %d%% done, %i %f %o %O', 'Form', 'Page', 42.5, '7.9', '1.5', { a: 1 }, [2], 'tail');
    target.console.warn('%cstyled%c text', 'color: red', '', { z: 1 });
    target.console.error('100%', 'no specifier here', '%s');
    target.console.error('%s and %s', 'one');
    expect(sent.map(({ message }) => message)).toEqual([
      'Warning: Form of Page is 42.5% done, 7 1.5 { a: 1 } [ 2 ] tail',
      'styled text { z: 1 }',
      '100% no specifier here %s',
      'one and %s',
    ]);
  });

  it('objects are shown to depth 3; the message is cut at the server’s limit, the stack too', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    target.console.error({ a: { b: { c: { d: { e: 1 } } } } });
    expect(sent[0]!.message).toBe('{ a: { b: { c: { d: [Object] } } } }');
    target.console.error('x'.repeat(10_000));
    expect(sent[1]!.message).toHaveLength(4096);
    const long = new Error('long');
    long.stack = 's'.repeat(40_000);
    target.console.error(long);
    expect(sent[2]!.stack).toHaveLength(16_384);
  });

  it('a burst of 100 reports sends 20, and the page still logs all 100', () => {
    const { target, calls } = page();
    let clock = 0;
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context, () => clock);
    for (let index = 0; index < 100; index++) target.console.error(`n${index}`);
    expect(sent).toHaveLength(20);
    expect(calls.error).toHaveLength(100);
    clock += 2000; // five a second: ten come back
    for (let index = 0; index < 20; index++) target.console.error('later');
    expect(sent).toHaveLength(30);
  });

  it('the notes on omitted arguments and held-back reports survive a message that fills the limit', () => {
    const { target } = page();
    let clock = 0;
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context, () => clock);
    for (let index = 0; index < 22; index++) target.console.error('n');
    clock += 1000;
    target.console.error('x'.repeat(5000), ...Array.from({ length: 30 }, () => 'y'));
    const { message } = sent.at(-1)!;
    expect(message.length).toBeLessThanOrEqual(4096);
    expect(message.endsWith('… 11 more arguments (2 more held back on the page)')).toBe(true);
  });

  it('a `[vite]` call is only a send failure with exactly one Error after it', async () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(
      target,
      (report) => {
        sent.push(report);
        if (report.message === 'first') {
          queueMicrotask(() => target.console.error('[vite]', 'text', new Error('x')));
          queueMicrotask(() => target.console.error('[vite]', new Error('y')));
        }
      },
      context,
    );
    target.console.error('first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The call with an extra argument is not Vite's send failure; the one with exactly an Error is.
    expect(sent.map(({ message }) => message.slice(0, 13))).toEqual(['first', '[vite] text E']);
  });

  it('what the page holds back goes into the next message that is sent', () => {
    const { target } = page();
    let clock = 0;
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context, () => clock);
    for (let index = 0; index < 25; index++) target.console.error(`n${index}`);
    expect(sent).toHaveLength(20);
    clock += 1000;
    target.console.error('after');
    expect(sent[20]!.message).toBe('after (5 more held back on the page)');
    clock += 1000;
    target.console.error('next');
    expect(sent[21]!.message).toBe('next');
    clock += 1000;
    for (let index = 0; index < 30; index++) target.console.error('x'.repeat(5000));
    expect(sent.at(-1)!.message.length).toBeLessThanOrEqual(4096);
  });

  it('Vite’s `[vite]` error for a send that failed is not reported; the same call for a failed module update, later, is', async () => {
    const { target, calls } = page();
    const sent: BrowserReport[] = [];
    let clock = 0;
    installBrowserLog(
      target,
      (report) => {
        sent.push(report);
        // The transport rejects; Vite's catch logs it a microtask later.
        queueMicrotask(() => target.console.error('[vite]', new Error('send was called before connect')));
      },
      context,
      () => clock,
    );
    target.console.error('first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.error).toHaveLength(2);
    expect(sent.map(({ message }) => message)).toEqual(['first']);
    clock += 1000;
    target.console.error('[vite]', new Error('Failed to reload /src/a.ts'));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message.startsWith('[vite] Error: Failed to reload')).toBe(true);
  });

  it('only the first 20 arguments are read, and the message says how many were left out', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    let reads = 0;
    const errors = Array.from({ length: 1000 }, () => Object.defineProperty(new Error('e'), 'stack', { get: () => (reads++, '') }));
    target.console.error('many', ...errors);
    // Once to look for a stack and once to print the Error, for 20 arguments at most.
    expect(reads).toBeLessThanOrEqual(40);
    expect(sent[0]!.message.endsWith('… 981 more arguments')).toBe(true);
  });

  it('after the hook is taken away, a wrapper another hook kept in the chain reports nothing', () => {
    const { target, calls } = page();
    const sent: BrowserReport[] = [];
    const stop = installBrowserLog(target, (report) => sent.push(report), context);
    const ours = target.console.error;
    target.console.error = (...args) => ours(...args); // another hook wraps ours
    const theirs = target.console.error;
    stop();
    expect(target.console.error).toBe(theirs);
    target.console.error('late');
    expect(calls.error).toEqual([['late']]);
    expect(sent).toEqual([]);
  });

  it('without a channel nothing is installed; the returned function takes the hook away', () => {
    const bare = page();
    const original = bare.target.console.error;
    installBrowserLog(bare.target, undefined, context)();
    expect(bare.target.console.error).toBe(original);
    expect(bare.listeners.size).toBe(0);

    const { target, listeners } = page();
    const first = target.console.error;
    const sent: BrowserReport[] = [];
    const stop = installBrowserLog(target, (report) => sent.push(report), context);
    expect(listeners.size).toBe(2);
    stop();
    expect(target.console.error).toBe(first);
    expect(listeners.size).toBe(0);
    target.console.error('after');
    expect(sent).toEqual([]);
  });
});
