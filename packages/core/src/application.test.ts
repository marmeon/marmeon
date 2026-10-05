import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createApplication, type Application } from './application.ts';
import { Clock, SystemClock, TestClock } from './clock.ts';
import { ConfigError, defineConfig } from './config/config.ts';
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

/**
 * The build phase (E187): what `bespoke build` needs of the app — every provider registered, none booted, and the configuration
 * that does not validate (the runtime secrets) left out instead of failing. Two measures, each with its own scenario: a boot
 * that would connect (here: one that records itself) and a configuration that cannot validate without `.env`.
 */
describe('createApplication({ phase: "build" }) (E187)', () => {
  const Secret = defineConfig('secret', {
    env: v.object({ APP_KEY: v.pipe(v.string('Missing'), v.nonEmpty('Missing')) }),
    resolve: (env) => ({ key: env.APP_KEY }),
  });
  const Plain = defineConfig('plain', {
    env: v.object({ PORT: v.optional(v.string(), '3000') }),
    resolve: (env) => ({ port: env.PORT }),
  });

  it('registers every provider and boots none — no connection, no shutdown hook afterwards', async () => {
    const { calls, provider } = recorder();
    const registered: string[] = [];
    class Registers implements ServiceProvider {
      register(): void {
        registered.push('register');
      }
      boot(): void {
        calls.push('boot (it would connect)');
      }
    }
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: { NODE_ENV: 'production' }, phase: 'build', providers: [provider('a'), Registers] });
    expect(app.phase).toBe('build');
    expect(registered).toEqual(['register']);
    expect(calls, 'a provider booted in the build phase').toEqual([]);
    await app.shutdown();
    expect(calls).toEqual([]);
    await expect(app.boot()).rejects.toThrow('An app in the build phase is never booted (E187)');
  });

  it('leaves out the configuration that does not validate — reading it says why; the rest is there', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: { NODE_ENV: 'production', PORT: '8080' }, phase: 'build', config: [Secret, Plain] });
    expect(app.container.make(Plain)).toEqual({ port: '8080' });
    expect(() => app.container.make(Secret)).toThrow(/^The configuration "secret" is not available while building — the build boots the app without runtime secrets \(E187\):\n {2}• secret: APP_KEY — .+\nRead it when the app runs/);
    expect(() => app.container.make(Secret)).toThrow(ConfigError);
  });

  it('a run fails as before: every problem at once, nothing registered', async () => {
    const registered: string[] = [];
    class Registers implements ServiceProvider {
      register(): void {
        registered.push('register');
      }
    }
    const error = await createApplication({ root: import.meta.dirname, discover: false, env: { NODE_ENV: 'production' }, config: [Secret, Plain], providers: [Registers] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/^Invalid configuration — the application cannot start:\n {2}• secret: APP_KEY — .+\nSet these variables in the environment or in \.env \(see \.env\.example\)\.$/);
    expect(registered).toEqual([]);
  });
});
