import type { Logger } from '@marmeon/core';
import { onTestFinished } from 'vitest';

/** How a log sink fails: its method throws, or returns a promise that rejects. */
export type SinkFailure = 'throws' | 'rejects';

export const SINK_FAILURES: readonly SinkFailure[] = ['throws', 'rejects'];

/** A logger whose `warn` and `error` fail the way `failure` says, as a sink that is down does. */
export function failingLogger(failure: SinkFailure): Logger {
  const fail = (): never | Promise<never> => {
    if (failure === 'throws') throw new Error('log sink down');
    return Promise.reject(new Error('log sink down'));
  };
  const logger = { debug() {}, info() {}, warn: fail, error: fail, child: () => logger } as unknown as Logger;
  return logger;
}

/** Collects the rejections nobody handled until the test ends; read it after `await settle()`. */
export function collectUnhandledRejections(): unknown[] {
  const seen: unknown[] = [];
  const collect = (reason: unknown) => void seen.push(reason);
  process.on('unhandledRejection', collect);
  onTestFinished(() => void process.off('unhandledRejection', collect));
  return seen;
}

/** Lets the microtasks and one macrotask run, so a rejection nobody handled has been reported. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
