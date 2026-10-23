import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createApplication } from './application.ts';
import { currentTransaction, runTransaction } from './transaction-context.ts';
import { Container } from './container.ts';
import { ErrorReports, FLUSH_TIMEOUT, MAX_OPEN_REPORTS, REPORT_TIMEOUT, startedByReporter, type ErrorReport, type ErrorReporter } from './error-reports.ts';
import { Logger, type LogContext } from './logger.ts';
import { defineModule } from './module.ts';
import { Redactor } from './redact.ts';

const PASSWORD = 'hunter2-s3cr3t';
const TOKEN = 'tok_live_9f8e7d6c5b4a39281706';
const APIKEY = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7n0123abcd';
const COOKIE = 'sessionvalue0123456789abcdef0123456789abcdef';

class MemoryLogger implements Logger {
  readonly errors: { message: string; context: LogContext }[] = [];
  readonly warnings: string[] = [];
  debug(): void {}
  info(): void {}
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(message: string, context: LogContext = {}): void {
    this.errors.push({ message, context });
  }
  child(): Logger {
    return this;
  }
}

const reports: ErrorReport[] = [];
class Collecting implements ErrorReporter {
  report(report: ErrorReport): void {
    reports.push(report);
  }
}

function setup(...reporters: (new () => ErrorReporter)[]) {
  const logger = new MemoryLogger();
  const redactor = new Redactor(['marmeon_session']);
  const container = new Container();
  const errorReports = new ErrorReports(logger, redactor, container, reporters);
  return { logger, errorReports, container };
}

const request = { source: 'request' as const, context: { method: 'GET', route: 'users.show', path: '/users/1' } };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  reports.length = 0;
});

describe('ErrorReports — what a reporter sees', () => {
  it('gets name, message, stack, code, status and cause with secrets masked', async () => {
    const { errorReports } = setup(Collecting);
    const inner = Object.assign(new Error(`token=${TOKEN} was refused`), { code: 'EAUTH' });
    const error = Object.assign(new Error(`connect failed: postgres://app:${PASSWORD}@db.internal/shop`, { cause: inner }), { status: 502 });
    error.stack = `${error.stack}\n    at request (cookie: marmeon_session=${COOKIE})`;
    errorReports.report(error, request);
    await settle();

    const seen = reports[0]!;
    const written = JSON.stringify(seen);
    for (const secret of [PASSWORD, TOKEN, COOKIE]) expect(written, `${secret} reached the reporter`).not.toContain(secret);
    expect(seen.error).toMatchObject({ name: 'Error', status: 502, code: undefined, cause: { code: 'EAUTH', status: undefined, cause: undefined } });
    expect(seen.error.message).toContain('postgres://');
    expect(seen.error.cause?.message).toContain('was refused');
    expect(seen).toMatchObject({ source: 'request', context: { method: 'GET', route: 'users.show', path: '/users/1' } });
  });

  it('never hands over the original error object', async () => {
    const { errorReports } = setup(Collecting);
    const error = new Error('boom');
    errorReports.report(error, request);
    await settle();
    const seen = reports[0]!;
    expect(seen.error).not.toBe(error);
    expect(seen.error).not.toBeInstanceOf(Error);
    expect(Object.values(seen)).not.toContain(error);
  });

  it('masks and bounds a cause chain, also a cyclic one', async () => {
    const { errorReports } = setup(Collecting);
    const a = new Error(`a token=${TOKEN}`);
    const b = new Error(`b token=${TOKEN}`, { cause: a });
    (a as { cause?: unknown }).cause = b;
    errorReports.report(b, request);
    let chain: Error = new Error(`level 0 token=${TOKEN}`);
    for (let level = 1; level < 20; level++) chain = new Error(`level ${level} token=${TOKEN}`, { cause: chain });
    errorReports.report(chain, request);
    await settle();

    expect(JSON.stringify(reports)).not.toContain(TOKEN);
    expect(reports[0]!.error.cause?.cause).toBeUndefined();
    let depth = 0;
    for (let cause = reports[1]!.error.cause; cause; cause = cause.cause) depth++;
    expect(depth).toBe(5);
  });

  it('takes a name only when it is an identifier, and a thrown string as an Error', async () => {
    const { errorReports } = setup(Collecting);
    const odd = new Error('x');
    odd.name = `Bad name with token=${TOKEN}`;
    errorReports.report(odd, request);
    errorReports.report(`plain token=${TOKEN}`, request);
    await settle();
    expect(reports[0]!.error.name).toBe('Error');
    expect(reports[1]!.error).toMatchObject({ name: 'Error', stack: '' });
    expect(JSON.stringify(reports)).not.toContain(TOKEN);
  });

  it('masks the values of the context too', async () => {
    const { errorReports } = setup(Collecting);
    errorReports.report(new Error('x'), { source: 'request', context: { path: `/hook?token=${TOKEN}` } });
    await settle();
    expect(JSON.stringify(reports)).not.toContain(TOKEN);
  });

  it('still writes the log line, masked', () => {
    const { errorReports, logger } = setup();
    errorReports.report(new Error(`connect failed: postgres://app:${PASSWORD}@db/shop`), request);
    expect(logger.errors).toHaveLength(1);
    expect(JSON.stringify(logger.errors)).not.toContain(PASSWORD);
  });

  it('writes the log line of the caller when it has one, masked, and none when told so', () => {
    const { errorReports, logger } = setup(Collecting);
    errorReports.report(new Error('x'), { source: 'job', log: { message: `Failed test.job: postgres://app:${PASSWORD}@db/shop`, fields: { job: 'test.job' } } });
    expect(logger.errors).toEqual([{ message: 'Failed test.job: postgres://app:***@db/shop', context: { job: 'test.job' } }]);
    errorReports.report(new Error('y'), { source: 'command', log: false });
    expect(logger.errors).toHaveLength(1);
  });

  it('tells code a reporter started from code that was not', async () => {
    const seen: boolean[] = [];
    class Asking implements ErrorReporter {
      async report(): Promise<void> {
        seen.push(startedByReporter());
        await Promise.resolve();
        seen.push(startedByReporter());
      }
    }
    const { errorReports } = setup(Asking);
    errorReports.report(new Error('x'), request);
    await settle();
    expect(seen).toEqual([true, true]);
    expect(startedByReporter()).toBe(false);
  });
});

describe('ErrorReports — a reporter that misbehaves', () => {
  class Throwing implements ErrorReporter {
    report(): void {
      throw new Error(`down: postgres://u:${PASSWORD}@h/db`);
    }
  }
  class Rejecting implements ErrorReporter {
    async report(): Promise<void> {
      throw new Error('rejected');
    }
  }
  class Hanging implements ErrorReporter {
    report(): Promise<void> {
      return new Promise(() => {});
    }
  }

  it('does not stop the next reporter, and warns once per reporter and report', async () => {
    const { errorReports, logger } = setup(Throwing, Rejecting, Collecting);
    errorReports.report(new Error('x'), request);
    await settle();
    expect(reports).toHaveLength(1);
    expect(logger.warnings).toHaveLength(2);
    expect(logger.warnings.filter((warning) => warning.includes('Rejecting'))).toHaveLength(1);
    expect(logger.warnings.join()).not.toContain(PASSWORD);
  });

  it('does not make the caller wait: report() returns before any reporter ran', () => {
    const { errorReports } = setup(Hanging, Collecting);
    errorReports.report(new Error('x'), request);
    expect(reports).toHaveLength(0);
  });

  it('does not loop when a reporter reports an error itself', async () => {
    const calls: string[] = [];
    let errorReports!: ErrorReports;
    class Reentrant implements ErrorReporter {
      async report(report: ErrorReport): Promise<void> {
        calls.push(report.error.message);
        // Without the lock this would go on for ever: the counter makes it end red instead of hanging.
        if (calls.length > 5) return;
        errorReports.report(new Error('from the reporter'), request);
        await Promise.resolve();
        errorReports.report(new Error('from the reporter, later'), request);
      }
    }
    const made = setup(Reentrant);
    errorReports = made.errorReports;
    errorReports.report(new Error('first'), request);
    await settle();
    await settle();
    expect(calls).toEqual(['first']);
    expect(made.logger.warnings).toEqual([]);
  });

  it('drops reports over the limit of open ones and warns once', async () => {
    const { errorReports, logger } = setup(Hanging);
    for (let index = 0; index < MAX_OPEN_REPORTS + 50; index++) errorReports.report(new Error(`storm ${index}`), request);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.errors).toHaveLength(MAX_OPEN_REPORTS + 50);
    await settle();
    expect(logger.warnings).toHaveLength(1);
  });

  it('reports again once the open ones are done', async () => {
    const { errorReports } = setup(Collecting);
    for (let index = 0; index < MAX_OPEN_REPORTS * 3; index++) {
      errorReports.report(new Error(`${index}`), request);
      await settle();
    }
    expect(reports).toHaveLength(MAX_OPEN_REPORTS * 3);
  });
});

describe('ErrorReports.flush', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls flush() of each reporter', async () => {
    const flushed: string[] = [];
    class Buffering implements ErrorReporter {
      report(): void {}
      async flush(): Promise<void> {
        flushed.push('Buffering');
      }
    }
    const { errorReports } = setup(Buffering);
    errorReports.report(new Error('x'), request);
    await vi.advanceTimersByTimeAsync(0);
    await errorReports.flush();
    expect(flushed).toEqual(['Buffering']);
  });

  it('waits at most two seconds for a reporter that hangs, then warns', async () => {
    class Stuck implements ErrorReporter {
      report(): void {}
      flush(): Promise<void> {
        return new Promise(() => {});
      }
    }
    const { errorReports, logger } = setup(Stuck);
    errorReports.report(new Error('x'), request);
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    const flushing = errorReports.flush().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(done).toBe(true);
    expect(logger.warnings.join()).toContain('did not finish');
  });

  it('gives up on a report that never ends, too', async () => {
    class Hangs implements ErrorReporter {
      report(): Promise<void> {
        return new Promise(() => {});
      }
    }
    const { errorReports } = setup(Hangs);
    errorReports.report(new Error('x'), request);
    const flushing = errorReports.flush();
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT);
    await expect(flushing).resolves.toBeUndefined();
  });

  it('does not throw when a reporter\'s flush fails', async () => {
    class Failing implements ErrorReporter {
      report(): void {}
      async flush(): Promise<void> {
        throw new Error('no network');
      }
    }
    const { errorReports, logger } = setup(Failing);
    errorReports.report(new Error('x'), request);
    await vi.advanceTimersByTimeAsync(0);
    await expect(errorReports.flush()).resolves.toBeUndefined();
    expect(logger.warnings).toHaveLength(1);
  });
});

describe('static errorReporters', () => {
  it('registers a provider\'s reporters and flushes them when the app shuts down', async () => {
    const seen: string[] = [];
    class Sink implements ErrorReporter {
      report(report: ErrorReport): void {
        seen.push(report.error.message);
      }
      async flush(): Promise<void> {
        seen.push('flushed');
      }
    }
    class SinkProvider {
      static errorReporters = [Sink];
    }
    const app = await createApplication({ root: import.meta.dirname, discover: false, modules: [defineModule({ name: 'x', providers: [SinkProvider] })] }, { env: { NODE_ENV: 'test' } });
    app.container.make(ErrorReports).report(new Error('seen'), request);
    await settle();
    await app.shutdown();
    expect(seen).toEqual(['seen', 'flushed']);
  });
});

describe('types', () => {
  it('requires report()', () => {
    // @ts-expect-error — a reporter without report() is not an ErrorReporter
    class NoReport implements ErrorReporter {
      flush(): Promise<void> {
        return Promise.resolve();
      }
    }
    expectTypeOf<ErrorReport['error']['cause']>().toEqualTypeOf<ErrorReport['error'] | undefined>();
    void NoReport;
  });
});

describe('ErrorReports — one reporter does not starve another', () => {
  class Hung implements ErrorReporter {
    report(): Promise<void> {
      return new Promise(() => {});
    }
  }

  it('gives a healthy reporter every report while another one hangs', async () => {
    const { errorReports, logger } = setup(Hung, Collecting);
    for (let index = 0; index < 2000; index++) {
      errorReports.report(new Error(`storm ${index}`), request);
      if (index % 50 === 0) await settle();
    }
    await settle();
    expect(reports).toHaveLength(2000);
    expect(logger.warnings.filter((warning) => warning.includes('Hung'))).toHaveLength(1);
  });

  /** Finishes a little after the limit: the call is given up on first, then settles. */
  class Late implements ErrorReporter {
    report(): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, REPORT_TIMEOUT + 500));
    }
  }

  it('frees the place of a call that takes longer than the limit once it settles, with a warning', async () => {
    vi.useFakeTimers();
    try {
      const { errorReports, logger } = setup(Late);
      for (let index = 0; index < MAX_OPEN_REPORTS; index++) errorReports.report(new Error('x'), request);
      await vi.advanceTimersByTimeAsync(REPORT_TIMEOUT);
      expect(logger.warnings.filter((warning) => warning.includes('did not finish'))).toHaveLength(MAX_OPEN_REPORTS);
      // Given up on, but still holding its report: no place yet.
      logger.warnings.length = 0;
      errorReports.report(new Error('y'), request);
      expect(logger.warnings).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      logger.warnings.length = 0;
      for (let index = 0; index < MAX_OPEN_REPORTS; index++) errorReports.report(new Error('z'), request);
      expect(logger.warnings).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds at most 100 reports of a reporter whose calls never settle, however long the flood lasts', async () => {
    vi.useFakeTimers();
    try {
      let received = 0;
      class NeverSettles implements ErrorReporter {
        report(): Promise<void> {
          received++;
          return new Promise(() => {});
        }
      }
      const { errorReports, logger } = setup(NeverSettles);
      for (let second = 0; second < 300; second++) {
        for (let index = 0; index < 50; index++) errorReports.report(new Error('x'), request);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(received).toBeLessThanOrEqual(MAX_OPEN_REPORTS);
      expect(logger.warnings.some((warning) => /never finished|reports open/.test(warning))).toBe(true);
      // The sum of what was dropped shows up during the flood, not only when it is over.
      expect(logger.warnings.some((warning) => /\d+ error reports were dropped/.test(warning))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says how many reports it dropped while a flood goes on and the list never empties', async () => {
    vi.useFakeTimers();
    try {
      class Slow implements ErrorReporter {
        report(): Promise<void> {
          return new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
      const { errorReports, logger } = setup(Slow);
      for (let second = 0; second < 130; second++) {
        for (let index = 0; index < 60; index++) errorReports.report(new Error('x'), request);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(logger.warnings.filter((warning) => /\d+ error reports were dropped/.test(warning)).length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns once about a stuck reporter, however many errors follow while a healthy one keeps finishing', async () => {
    vi.useFakeTimers();
    try {
      class Stuck extends Hung {}
      const { errorReports, logger } = setup(Stuck, Collecting);
      for (let index = 0; index < MAX_OPEN_REPORTS + 5; index++) errorReports.report(new Error('x'), request);
      // Everything given up on: nothing is open, the healthy reporter finishes each report on its own.
      await vi.advanceTimersByTimeAsync(REPORT_TIMEOUT);
      for (let index = 0; index < 50; index++) {
        errorReports.report(new Error('y'), request);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(logger.warnings.filter((warning) => /Stuck has (calls that never|\d+ reports open)/.test(warning))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says how many reports it dropped, at most once a minute', async () => {
    vi.useFakeTimers();
    try {
      const { errorReports, logger } = setup(Late);
      const storm = async () => {
        for (let index = 0; index < MAX_OPEN_REPORTS + 7; index++) errorReports.report(new Error('x'), request);
        await vi.advanceTimersByTimeAsync(REPORT_TIMEOUT + 1000);
      };
      const lines = () => logger.warnings.filter((warning) => warning.includes('were dropped'));
      await storm();
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toContain('7 error reports were dropped');
      await storm();
      expect(lines()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await storm();
      expect(lines()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns once for each reporter that is stuck', async () => {
    class HungOne extends Hung {}
    class HungTwo extends Hung {}
    const { errorReports, logger } = setup(HungOne, HungTwo);
    for (let index = 0; index < MAX_OPEN_REPORTS + 5; index++) errorReports.report(new Error('x'), request);
    expect(logger.warnings.filter((warning) => warning.includes('HungOne'))).toHaveLength(1);
    expect(logger.warnings.filter((warning) => warning.includes('HungTwo'))).toHaveLength(1);
  });
});

describe('ErrorReports — a reporter that cannot be built', () => {
  it('stops the start with K12, naming reporter and provider but no value', async () => {
    class NeedsDsn implements ErrorReporter {
      constructor() {
        throw new TypeError('Invalid DSN https://key:s3cr3tkey@tracker.example/1');
      }
      report(): void {}
    }
    class TrackerProvider {
      static errorReporters = [NeedsDsn];
    }
    const failure = await createApplication({ root: import.meta.dirname, discover: false, modules: [defineModule({ name: 'x', providers: [TrackerProvider] })] }, { env: { NODE_ENV: 'test' } }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain('[marmeon:K12]');
    expect(failure?.message).toContain('NeedsDsn');
    expect(failure?.message).toContain('TrackerProvider');
    expect(failure?.message).not.toContain('s3cr3tkey');
    expect(failure?.cause).toBeUndefined();
  });
});

describe('ErrorReports — the start message does not repeat values', () => {
  const failing = async (Reporter: new () => ErrorReporter) => {
    class Provider {
      static errorReporters = [Reporter];
    }
    return createApplication({ root: import.meta.dirname, discover: false, modules: [defineModule({ name: 'x', providers: [Provider] })] }, { env: { NODE_ENV: 'test' } }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
  };

  it('leaves out an error name that is not an identifier', async () => {
    class Dsn implements ErrorReporter {
      constructor() {
        throw Object.assign(new Error('x'), { name: 'InvalidDsn https://key:s3cret@tracker.example/1' });
      }
      report(): void {}
    }
    const failure = await failing(Dsn);
    expect(failure?.message).toContain('[marmeon:K12]');
    expect(failure?.message).not.toContain('s3cret');
  });

  it('survives an error whose name throws', async () => {
    class Hostile implements ErrorReporter {
      constructor() {
        const error = new Error('x');
        Object.defineProperty(error, 'name', {
          get() {
            throw new Error('no name');
          },
        });
        throw error;
      }
      report(): void {}
    }
    const failure = await failing(Hostile);
    expect(failure?.message).toContain('[marmeon:K12]');
    expect(failure?.message).toContain('Hostile');
  });
});

describe('ErrorReports — where a reporter runs', () => {
  it('outside the transaction of the code that reports', async () => {
    const inside: unknown[] = [];
    class Looking implements ErrorReporter {
      async report(): Promise<void> {
        await Promise.resolve();
        inside.push(currentTransaction());
      }
      flush(): Promise<void> {
        inside.push(currentTransaction());
        return Promise.resolve();
      }
    }
    const { errorReports } = setup(Looking);
    await runTransaction({}, 'test', async () => {
      expect(currentTransaction()).toBeDefined();
      errorReports.report(new Error('x'), request);
      await errorReports.flush();
    });
    await settle();
    expect(inside).toEqual([undefined, undefined]);
  });

  it('is built when the app boots, once', async () => {
    let built = 0;
    class Counting implements ErrorReporter {
      constructor() {
        built++;
      }
      report(): void {}
    }
    class CountingProvider {
      static errorReporters = [Counting];
    }
    const app = await createApplication({ root: import.meta.dirname, discover: false, modules: [defineModule({ name: 'x', providers: [CountingProvider] })] }, { env: { NODE_ENV: 'test' } });
    expect(built).toBe(1);
    app.container.make(ErrorReports).report(new Error('x'), request);
    await settle();
    expect(built).toBe(1);
  });
});

describe('ErrorReports — flush while reports hang', () => {
  it('still calls flush() of the other reporters', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[] = [];
      class Hanging implements ErrorReporter {
        report(): Promise<void> {
          return new Promise(() => {});
        }
      }
      class Buffering implements ErrorReporter {
        report(): void {}
        async flush(): Promise<void> {
          flushed.push('Buffering');
        }
      }
      const { errorReports } = setup(Hanging, Buffering);
      errorReports.report(new Error('x'), request);
      const flushing = errorReports.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(flushed).toEqual(['Buffering']);
      await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT);
      await flushing;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ErrorReports — what a reporter cannot change or break', () => {
  it('gets a frozen report, in every level', async () => {
    const frozen: boolean[] = [];
    class Meddling implements ErrorReporter {
      report(report: ErrorReport): void {
        frozen.push(Object.isFrozen(report), Object.isFrozen(report.context), Object.isFrozen(report.error), Object.isFrozen(report.error.cause));
        expect(() => {
          (report.error as { message: string }).message = 'changed';
        }).toThrow(TypeError);
      }
    }
    const { errorReports, logger } = setup(Meddling, Collecting);
    errorReports.report(new Error('first', { cause: new Error('inner') }), request);
    await settle();
    expect(frozen).toEqual([true, true, true, true]);
    expect(reports[0]!.error.message).toBe('first');
    expect(logger.warnings).toEqual([]);
  });

  it('reports an error whose cause getter throws, whose cause is a hostile proxy, or whose toString throws', async () => {
    const { errorReports, logger } = setup(Collecting);
    const throwingGetter = new Error('getter');
    Object.defineProperty(throwingGetter, 'cause', {
      get() {
        throw new Error('no cause for you');
      },
    });
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('no prototype');
        },
      },
    );
    const proxied = new Error('proxied', { cause: hostile });
    const unprintable = {
      toString() {
        throw new Error('no text');
      },
    };
    errorReports.report(throwingGetter, request);
    errorReports.report(proxied, request);
    errorReports.report(unprintable, request);
    errorReports.report(hostile, request);
    await settle();
    expect(reports).toHaveLength(4);
    expect(reports[0]!.error).toMatchObject({ message: 'getter', cause: undefined });
    expect(reports[1]!.error.cause).toMatchObject({ message: 'Unprintable error' });
    expect(reports[2]!.error).toMatchObject({ name: 'Error', message: 'Unprintable error' });
    expect(reports[3]!.error.message).toBe('Unprintable error');
    expect(logger.errors).toHaveLength(4);
  });

  it('masks the name too', async () => {
    const { errorReports } = setup(Collecting);
    const odd = new Error('x');
    odd.name = `sk_${APIKEY}`;
    errorReports.report(odd, request);
    await settle();
    expect(reports[0]!.error.name).toBe('Error');
    expect(JSON.stringify(reports)).not.toContain(APIKEY);
  });
});
