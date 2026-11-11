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

  it('a cyclic object, a getter that throws and a hostile proxy are formatted, never thrown', () => {
    const { target } = page();
    const sent: BrowserReport[] = [];
    installBrowserLog(target, (report) => sent.push(report), context);
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const getter = Object.defineProperty({}, 'bad', { enumerable: true, get: () => { throw new Error('getter'); } });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
    expect(() => target.console.error(cyclic, getter, proxy)).not.toThrow();
    expect(sent[0]!.message).toBe('[unprintable]');
    target.console.error(cyclic);
    expect(sent[1]!.message).toBe('{ name: "loop", self: [Circular] }');
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
