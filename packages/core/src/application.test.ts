import { describe, expect, it } from 'vitest';
import { createApplication, type Application } from './application.ts';
import { Clock, SystemClock, TestClock } from './clock.ts';
import { Logger } from './logger.ts';
import type { ServiceProvider } from './provider.ts';

function recorder() {
  const calls: string[] = [];
  const provider = (name: string, fail = false) =>
    class implements ServiceProvider {
      boot(): void {
        calls.push(`boot ${name}`);
      }
      shutdown(app: Application): void {
        calls.push(`shutdown ${name}${app ? '' : ' (no app)'}`);
        if (fail) throw new Error(`${name} failed`);
      }
    };
  return { calls, provider };
}

describe('Application.shutdown', () => {
  it('shuts providers down in reverse boot order, once', async () => {
    const { calls, provider } = recorder();
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [provider('a'), provider('b')] });
    await Promise.all([app.shutdown(), app.shutdown()]);
    await app.shutdown();
    expect(calls).toEqual(['boot a', 'boot b', 'shutdown b', 'shutdown a']);
  });

  it('gives every provider its turn and reports all failures', async () => {
    const { calls, provider } = recorder();
    const app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      env: {},
      providers: [provider('a', true), provider('b'), provider('c', true)],
    });
    const error = await app.shutdown().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['c failed', 'a failed']);
    expect(calls.filter((c) => c.startsWith('shutdown'))).toEqual(['shutdown c', 'shutdown b', 'shutdown a']);
  });

  it('works with `await using`', async () => {
    const { calls, provider } = recorder();
    {
      await using _app = await createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [provider('a')] });
    }
    expect(calls).toEqual(['boot a', 'shutdown a']);
  });

  it('accepts a provider that only shuts down', async () => {
    const OnlyShutdown = class implements ServiceProvider {
      shutdown(): void {}
    };
    await expect(createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [OnlyShutdown] })).resolves.toBeDefined();
  });
});

// E128: the W6.6 case — a defaulted Clock is never injected; in development the app says so in its log.
class DueDates {
  readonly clock: Clock;
  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }
}

describe('injection warnings in the log (E128)', () => {
  const boot = async (nodeEnv: string) => {
    const warnings: string[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (message) => void warnings.push(message), error() {}, child: () => logger };
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: { NODE_ENV: nodeEnv }, override: (container) => container.instance(Logger, logger) });
    app.container.instance(Clock, new TestClock());
    return { app, warnings };
  };

  it('development: once per class, when the container first builds it — the default is used, no error', async () => {
    const { app, warnings } = await boot('development');
    expect(app.container.make(DueDates).clock).toBeInstanceOf(SystemClock); // not the bound TestClock: what the warning is about
    app.container.make(DueDates);
    expect(warnings).toEqual([expect.stringMatching(/^Injection: DueDates \(.*application\.test\.ts:\d+\): the parameter "clock: Clock = new SystemClock\(\)" is defaulted/)]);
    expect(app.container.warnings).toHaveLength(1);
  });

  it('elsewhere: not logged — still listed for the error page', async () => {
    const { app, warnings } = await boot('test');
    app.container.make(DueDates);
    expect(warnings).toEqual([]);
    expect(app.container.warnings).toHaveLength(1);
  });
});
