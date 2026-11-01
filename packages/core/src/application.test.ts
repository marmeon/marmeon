import { afterEach, describe, expect, it, vi } from 'vitest';
import { Application, createApplication, PROVIDER_STATICS, type ApplicationDefinition } from './application.ts';
import { Container } from './container.ts';
import { Clock, SystemClock, TestClock } from './clock.ts';
import { ConfigError, defineConfig } from './config/config.ts';
import { env } from './config/env.ts';
import { EnvironmentConfig } from './config/environment-config.ts';
import { Logger } from './logger.ts';
import { Redactor } from './redact.ts';
import { coreSolutions } from './core-solutions.ts';
import { defineSolutions, ErrorSolutions } from './solutions.ts';
import { defineModule } from './module.ts';
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
    const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [provider('a'), provider('b')] }, { env: {} });
    await Promise.all([app.shutdown(), app.shutdown()]);
    await app.shutdown();
    expect(calls).toEqual(['boot a', 'boot b', 'shutdown b', 'shutdown a']);
  });

  it('gives every provider its turn and reports all failures', async () => {
    const { calls, provider } = recorder();
    const app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [provider('a', true), provider('b'), provider('c', true)],
    }, { env: {} });
    const error = await app.shutdown().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['c failed', 'a failed']);
    expect(calls.filter((c) => c.startsWith('shutdown'))).toEqual(['shutdown c', 'shutdown b', 'shutdown a']);
  });

  describe('the time limit of a provider', () => {
    afterEach(() => vi.useRealTimers());

    function stuckApp(shutdownEnv: Record<string, string> = {}, reject = false) {
      const calls: string[] = [];
      const warnings: string[] = [];
      const logger: Logger = { debug() {}, info() {}, warn: (message) => void warnings.push(message), error() {}, child: () => logger };
      class First {
        shutdown(): void {
          calls.push('first');
        }
      }
      class Stuck {
        shutdown(): Promise<void> {
          calls.push('stuck');
          return reject ? Promise.reject(new Error('stuck failed')) : new Promise<void>(() => {});
        }
      }
      class Last {
        shutdown(): void {
          calls.push('last');
        }
      }
      const app = createApplication({ root: import.meta.dirname, discover: false, providers: [First, Stuck, Last] }, { env: shutdownEnv, override: (container) => container.instance(Logger, logger) });
      return { app, calls, warnings };
    }

    it('goes on after 10 seconds, in reverse order, and names the provider', async () => {
      vi.useFakeTimers();
      const { app: pending, calls, warnings } = stuckApp();
      const app = await pending;
      let done = false;
      const shutdown = app.shutdown().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(done).toBe(false);
      expect(calls).toEqual(['last', 'stuck']);
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(calls).toEqual(['last', 'stuck', 'first']);
      expect(warnings).toEqual(['Stuck.shutdown() did not finish within 10 s (APP_SHUTDOWN_TIMEOUT_SECONDS); going on with the next provider']);
      expect(app.stuckProviders).toEqual(['Stuck']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer behind after a shutdown within the limit', async () => {
      vi.useFakeTimers();
      const { provider } = recorder();
      const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [provider('a')] }, { env: {} });
      await app.shutdown();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('warns about a provider left behind that fails later', async () => {
      vi.useFakeTimers();
      const warnings: string[] = [];
      const logger: Logger = { debug() {}, info() {}, warn: (message) => void warnings.push(message), error() {}, child: () => logger };
      let fail: (error: Error) => void = () => {};
      class Late {
        shutdown(): Promise<void> {
          return new Promise<void>((_, reject) => (fail = reject));
        }
      }
      const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [Late] }, { env: {}, override: (container) => container.instance(Logger, logger) });
      const shutdown = app.shutdown();
      await vi.advanceTimersByTimeAsync(10_000);
      await shutdown;
      fail(new Error('too late'));
      await vi.advanceTimersByTimeAsync(0);
      expect(warnings.at(-1)).toBe('Late.shutdown() failed after its time limit: too late');
    });

    it('does not read the limit in the build phase', async () => {
      const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [recorder().provider('a')] }, { env: { APP_SHUTDOWN_TIMEOUT_SECONDS: 'soon' }, phase: 'build' });
      await expect(app.shutdown()).resolves.toBeUndefined();
    });

    it('reads the limit from APP_SHUTDOWN_TIMEOUT_SECONDS', async () => {
      vi.useFakeTimers();
      const { app: pending, calls } = stuckApp({ APP_SHUTDOWN_TIMEOUT_SECONDS: '0.5' });
      const app = await pending;
      expect(app.shutdownTimeoutMs).toBe(500);
      const shutdown = app.shutdown();
      await vi.advanceTimersByTimeAsync(500);
      await shutdown;
      expect(calls).toEqual(['last', 'stuck', 'first']);
    });

    it('runs the others when a provider rejects, without a warning', async () => {
      const { app: pending, calls, warnings } = stuckApp({}, true);
      const app = await pending;
      await expect(app.shutdown()).rejects.toThrow('stuck failed');
      expect(calls).toEqual(['last', 'stuck', 'first']);
      expect(warnings).toEqual([]);
      expect(app.stuckProviders).toEqual([]);
    });
  });

  it('works with `await using`', async () => {
    const { calls, provider } = recorder();
    {
      await using _app = await createApplication({ root: import.meta.dirname, discover: false, providers: [provider('a')] }, { env: {} });
    }
    expect(calls).toEqual(['boot a', 'shutdown a']);
  });

  it('accepts a provider that only shuts down', async () => {
    const OnlyShutdown = class implements ServiceProvider {
      shutdown(): void {}
    };
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [OnlyShutdown] }, { env: {} })).resolves.toBeDefined();
  });

  it('accepts a provider that only brings solutions — and still stops one that brings nothing', async () => {
    const OnlySolutions = class {
      static solutions = defineSolutions([{ for: RangeError, solve: () => ({ title: 'Never', text: 'never' }) }]);
    };
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [OnlySolutions] }, { env: {} })).resolves.toBeDefined();
    const Empty = class Empty {};
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [Empty] }, { env: {} })).rejects.toThrow(
      '[marmeon:K9] Empty is listed as a service provider but has no register(), boot(), shutdown(), static config, static health, static errorReporters, static solutions, static commands, static queueDrivers, static failedJobDrivers, static diskDrivers, static cacheDrivers, static mailDrivers, static checks, static migrations or static publishes.',
    );
    // A list named migrationUpgrades brings nothing.
    const Revisions = class Revisions {
      static migrationUpgrades = [{ name: 'add_label' }];
    };
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [Revisions] }, { env: {} })).rejects.toThrow('[marmeon:K9] Revisions is listed as a service provider');
    const OnlyCommands = class OnlyCommands {
      static commands = [class {}];
    };
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [OnlyCommands] }, { env: {} })).resolves.toBeDefined();
    // A package that only ships tables declares nothing else; an empty record brings nothing.
    const OnlyMigrations = class OnlyMigrations {
      static migrations = { from: new URL('./stubs/migrations', import.meta.url), module: 'things' };
    };
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [OnlyMigrations] }, { env: {} })).resolves.toBeDefined();
    const NoMigrations = class NoMigrations {
      static migrations = {};
    };
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [NoMigrations] }, { env: {} })).rejects.toThrow('[marmeon:K9] NoMigrations is listed as a service provider');
  });
});

// A defaulted Clock is never injected; in development the app says so in its log.
class DueDates {
  readonly clock: Clock;
  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }
}

describe('injection warnings in the log', () => {
  const boot = async (nodeEnv: string) => {
    const warnings: string[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (message) => void warnings.push(message), error() {}, child: () => logger };
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: { NODE_ENV: nodeEnv }, override: (container) => container.instance(Logger, logger) });
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
 * The build phase: what `marmeon build` needs of the app — every provider registered, none booted, and the configuration
 * that does not validate (the runtime secrets) left out instead of failing. Two measures, each with its own scenario: a boot
 * that would connect (here: one that records itself) and a configuration that cannot validate without `.env`.
 */
describe('createApplication({ phase: "build" })', () => {
  const Secret = defineConfig('secret', {
    env: env({ APP_KEY: env.string() }),
    resolve: (e) => ({ key: e.APP_KEY }),
  });
  const Plain = defineConfig('plain', {
    env: env({ PORT: env.string().default('3000') }),
    resolve: (e) => ({ port: e.PORT }),
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
    const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [provider('a'), Registers] }, { env: { NODE_ENV: 'production' }, phase: 'build' });
    expect(app.phase).toBe('build');
    expect(registered).toEqual(['register']);
    expect(calls, 'a provider booted in the build phase').toEqual([]);
    await app.shutdown();
    expect(calls).toEqual([]);
    await expect(app.boot()).rejects.toThrow('An app in the build phase is never booted: ');
  });

  it('leaves out the configuration that does not validate — reading it says why; the rest is there', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, config: [Secret, Plain] }, { env: { NODE_ENV: 'production', PORT: '8080' }, phase: 'build' });
    expect(app.container.make(Plain)).toEqual({ port: '8080' });
    expect(() => app.container.make(Secret)).toThrow(/^The configuration "secret" is not available while building — the build boots the app without runtime secrets:\n {2}• secret: APP_KEY — .+\nRead it when the app runs/);
    expect(() => app.container.make(Secret)).toThrow(ConfigError);
    // It is no start error (no K6): the solution "Set X in .env" does not apply to it.
    let thrown: unknown;
    try {
      app.container.make(Secret);
    } catch (error) {
      thrown = error;
    }
    expect(await new ErrorSolutions(coreSolutions).find(thrown)).toEqual([]);
  });

  it('a run fails as before: every problem at once, nothing registered', async () => {
    const registered: string[] = [];
    class Registers implements ServiceProvider {
      register(): void {
        registered.push('register');
      }
    }
    const error = await createApplication({ root: import.meta.dirname, discover: false, config: [Secret, Plain], providers: [Registers] }, { env: { NODE_ENV: 'production' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/^\[marmeon:K6\] Invalid configuration — the application cannot start:\n {2}• secret: APP_KEY — .+\nSet or rename these variables in the environment or in \.env \(see \.env\.example\)\.$/);
    expect(registered).toEqual([]);
  });
});

describe('the environment', () => {
  it('stops the start at a NODE_ENV that is none of development, test, production — also for an app given its own env', async () => {
    await expect(createApplication({ root: import.meta.dirname, discover: false }, { env: { NODE_ENV: 'staging' } })).rejects.toThrow(ConfigError);
    await expect(createApplication({ root: import.meta.dirname, discover: false }, { env: { NODE_ENV: 'staging' } })).rejects.toThrow(
      'NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging.',
    );
  });

  it('every app has EnvironmentConfig: NODE_ENV and APP_ENV, read like every variable — APP_ENV by default the one NODE_ENV goes with', async () => {
    const read = async (environment: Record<string, string>) =>
      (await createApplication({ root: import.meta.dirname, discover: false }, { env: environment })).container.make(EnvironmentConfig);
    expect(await read({ NODE_ENV: 'production', APP_ENV: 'staging' })).toEqual({ node: 'production', app: 'staging' });
    expect(await read({ NODE_ENV: 'production', APP_ENV: '' })).toEqual({ node: 'production', app: 'production' });
    expect(await read({})).toEqual({ node: 'production', app: 'production' });
    expect(await read({ NODE_ENV: 'development' })).toEqual({ node: 'development', app: 'local' });
    expect(await read({ NODE_ENV: 'test' })).toEqual({ node: 'test', app: 'testing' });
  });
});

describe('Application.providers', () => {
  class A implements ServiceProvider {
    register(): void {}
  }
  class B implements ServiceProvider {
    register(): void {}
  }
  const seen: (readonly unknown[])[] = [];
  class Reader implements ServiceProvider {
    register(container: Container): void {
      seen.push(container.make(Application).providers);
    }
  }

  for (const phase of ['run', 'build'] as const) {
    it(`lists the app's and the modules' providers in register order (${phase})`, async () => {
      const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [A], modules: [defineModule({ name: 'm', providers: [B] })] }, { env: {}, phase });
      expect(app.providers).toEqual([A, B]);
      expect(Object.isFrozen(app.providers)).toBe(true);
    });

    it(`shows a provider the ones registered after it (${phase})`, async () => {
      seen.length = 0;
      await createApplication({ root: import.meta.dirname, discover: false, providers: [Reader], modules: [defineModule({ name: 'm', providers: [B] })] }, { env: {}, phase });
      expect(seen).toEqual([[Reader, B]]);
    });
  }
});

describe('createApplication(definition, options)', () => {
  class Note {}
  class BindsNote implements ServiceProvider {
    register(container: Container): void {
      container.singleton(Note, () => new Note());
    }
  }

  it('boots with the options: the environment, and an override that runs after the providers registered', async () => {
    const definition = { root: import.meta.dirname, discover: false, providers: [BindsNote] };
    const replacement = new Note();
    const app = await createApplication(definition, { env: { NODE_ENV: 'test' }, override: (container) => container.instance(Note, replacement) });
    expect(app.container.make(Note)).toBe(replacement);
    expect(app.container.make(EnvironmentConfig).node).toBe('test');
    expect(app.definition).toBe(definition);
  });

  it.each(['env', 'phase', 'container', 'override'])('refuses a definition that carries `%s`, also by a spread', async (key) => {
    const smuggled = { [key]: undefined };
    const refused = createApplication({ root: import.meta.dirname, discover: false, ...smuggled });
    await expect(refused).rejects.toBeInstanceOf(TypeError);
    await expect(refused).rejects.toThrow(`[marmeon:K10] \`${key}\` is a boot option: pass it as createApplication(definition, { ${key} })`);
  });

  it("builds the app's redactor from `redact`: the names and the patterns every redactor of the app has", async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, redact: { keys: ['iban'], patterns: [/\bDE\d{20}\b/] } });
    const redactor = app.container.make(Redactor);
    expect(redactor.isSensitive('iban')).toBe(true);
    expect(redactor.isSensitive('password')).toBe(true);
    expect(redactor.text('DE89370400440532013000')).toBe('[redacted]');
  });

  it('refuses a pattern (K15) before discovery and before any provider registers', async () => {
    const calls: string[] = [];
    class Spy {
      register(): void {
        calls.push('register');
      }
      boot(): void {
        calls.push('boot');
      }
    }
    const definition = { root: import.meta.dirname, providers: [Spy], redact: { patterns: [/(a+)+$/] } };
    await expect(createApplication(definition)).rejects.toThrow(/^\[marmeon:K15\]/);
    await expect(createApplication({ ...definition, redact: { patterns: [/a*/] } })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it('refuses an inherited boot option too', async () => {
    const inherited: ApplicationDefinition = Object.create({ override() {} }, { root: { value: import.meta.dirname, enumerable: true } });
    await expect(createApplication(inherited)).rejects.toBeInstanceOf(TypeError);
  });

  it('accepts a provider that only brings drivers, and refuses one with an empty record', async () => {
    class OnlyDrivers {
      static queueDrivers = { sqs: () => ({}) };
    }
    class EmptyDrivers {
      static queueDrivers = {};
    }
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [OnlyDrivers as never] }, { env: {} })).resolves.toBeDefined();
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [EmptyDrivers as never] }, { env: {} })).rejects.toThrow(/static queueDrivers/);
  });

  it('boots a clean definition', async () => {
    await expect(createApplication({ root: import.meta.dirname, discover: false }, { env: {} })).resolves.toBeDefined();
  });

  it('keeps the options out of the definition the app exposes', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {}, override: () => {} });
    expect(app.definition).not.toHaveProperty('env');
    expect(app.definition).not.toHaveProperty('override');
  });

  describe.each(PROVIDER_STATICS)('a provider with only static %s', (key) => {
    const register = (value: unknown) => {
      const Provider = class Only {};
      Object.defineProperty(Provider, key, { value });
      new Application({ root: import.meta.dirname, container: new Container(), modules: [], packages: [] }).register([Provider]);
    };

    it('is accepted when the static lists something', () => {
      expect(() => register(['config', 'health', 'errorReporters', 'solutions', 'commands', 'checks'].includes(key) ? [class {}] : { entry: class {} })).not.toThrow();
    });

    it('is refused when the static is empty', () => {
      expect(() => register([])).toThrow('[marmeon:K9]');
      expect(() => register({})).toThrow('[marmeon:K9]');
    });
  });
});
