import cluster from 'node:cluster';
import { ConfigError, loadEnv, resolveConfig, type ConfigDefinition } from './config/config.ts';
import { Container } from './container.ts';
import { coreSolutions } from './core-solutions.ts';
import { Redactor } from './redact.ts';
import { ErrorSolutions } from './solutions.ts';
import { loadDiscoveredPackages } from './discovery/discover.ts';
import { environment, resolveEnvironment } from './environment.ts';
import { EventDispatcher, EventRegistry, isQueuedListener, ListenerQueue, missingListenerQueue, type ListenerBinding } from './events.ts';
import { EventFake } from './events-fake.ts';
import { Clock, SystemClock } from './clock.ts';
import { HealthChecks, type HealthCheckClass } from './health.ts';
import { takeInjectionWarning } from './injection/artifacts.ts';
import { ConsoleLogger, LogContextSources, Logger } from './logger.ts';
import type { ModuleDefinition } from './module.ts';
import type { ServiceProvider, ServiceProviderClass } from './provider.ts';

/**
 * How an app is defined. Packages add their own app-level settings through
 * declaration merging, like `ModuleDefinition` (http adds `middleware`).
 */
export interface ApplicationOptions {
  /** App root: package.json, `.bespoke/`, `index.html`. */
  root: string;
  /** Feature modules, in the order they should register and boot. */
  modules?: readonly ModuleDefinition[];
  /** Extra app-level providers (booted after packages, before modules). */
  providers?: readonly ServiceProviderClass[];
  /** App-level event listeners; modules bring their own through `listeners`. */
  listeners?: readonly ListenerBinding[];
  /** App-level configuration; modules can contribute their own through `config`. */
  config?: readonly ConfigDefinition<any>[];
  /** App-level readiness checks for `/up/ready` (E126); packages and modules bring their own through `health`. */
  health?: readonly HealthCheckClass[];
  /**
   * Environment to validate the configuration against. Default: `.env`, then
   * `.env.{NODE_ENV}`, then the real environment (which wins).
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Register providers of installed packages (`bespoke discover`). Default: true. */
  discover?: boolean;
  container?: Container;
  /**
   * Runs after every provider registered and before any boots — the place to
   * replace bindings, e.g. with test doubles, so even singletons see them.
   */
  override?: (container: Container) => void;
}

/**
 * Describes the application without booting it — the default export of
 * `bootstrap/app.ts`. The CLI boots it; tests boot a fresh instance per test.
 */
export function defineApplication(options: ApplicationOptions): ApplicationOptions {
  return options;
}

/**
 * The application: owns the container, the modules and the provider lifecycle.
 *
 * Configuration is validated and bound first — a start with missing or invalid
 * variables fails before anything else runs, listing every problem at once.
 *
 * Boot order — every provider registers before any provider boots:
 * 1. providers of installed packages (dependencies first, from `bespoke discover`)
 * 2. app-level providers
 * 3. module providers, in module order
 */
export class Application {
  readonly root: string;
  readonly container: Container;
  readonly modules: readonly ModuleDefinition[];
  /** Names of the installed packages whose providers were discovered. */
  readonly packages: readonly string[];
  /** What the app was defined with — packages read their app-level settings from here (e.g. http's `middleware`). */
  readonly options: ApplicationOptions;
  readonly #providers: ServiceProvider[] = [];
  #shutdown: Promise<void> | undefined;

  constructor(options: {
    root: string;
    container: Container;
    modules: readonly ModuleDefinition[];
    packages: readonly string[];
    options?: ApplicationOptions;
  }) {
    this.root = options.root;
    this.container = options.container;
    this.modules = options.modules;
    this.packages = options.packages;
    this.options = options.options ?? { root: options.root };
  }

  /** Register phase: build each provider through the container and let it bind services. */
  register(providers: readonly ServiceProviderClass[]): void {
    // A provider may also only bring configuration (`static config`), which is validated earlier.
    for (const Provider of providers) {
      const provider = this.container.make(Provider);
      const hooks = [provider.register, provider.boot, provider.shutdown].some((hook) => typeof hook === 'function');
      if (!hooks && !Provider.config?.length && !Provider.health?.length) {
        throw new TypeError(`${Provider.name} is listed as a service provider but has no register(), boot(), shutdown(), static config or static health.`);
      }
      provider.register?.(this.container);
      this.#providers.push(provider);
    }
  }

  /** Boot phase: runs once every provider has registered. */
  async boot(): Promise<void> {
    for (const provider of this.#providers) await provider.boot?.(this);
  }

  /**
   * Stops the app: every provider's `shutdown`, in reverse order (a provider shuts down
   * before the ones it was booted after). Runs once — later calls return the same promise.
   * Every provider gets its turn even if an earlier one fails; failures are thrown together.
   *
   * The CLI calls it after a command, the server on SIGINT/SIGTERM, tests via `await using`.
   */
  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      const errors: unknown[] = [];
      for (const provider of this.#providers.toReversed()) {
        try {
          await provider.shutdown?.(this);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `${errors.length} providers failed to shut down.`);
    })();
    return this.#shutdown;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.shutdown();
  }
}

/** Set by the primary of `bespoke start --workers=N` for its workers (E140): the boot's warnings were said once, by the primary. */
export const CLUSTER_WORKER = 'BESPOKE_CLUSTER_WORKER';

/**
 * The app's logger, without `warn` until `end()` — every child too, and every service that took it while booting logs its
 * warnings again afterwards (the same logger, switched on).
 */
function quietWhileBooting(container: Container): { end(): void } {
  const logger = container.make(Logger);
  let booting = true;
  const quiet = (inner: Logger): Logger => ({
    debug: (message, context) => inner.debug(message, context),
    info: (message, context) => inner.info(message, context),
    warn: (message, context) => void (booting || inner.warn(message, context)),
    error: (message, context) => inner.error(message, context),
    child: (bindings) => quiet(inner.child(bindings)),
  });
  container.instance(Logger, quiet(logger));
  return {
    end: () => {
      booting = false;
    },
  };
}

/** Creates and boots the application — the composition root of `bootstrap/app.ts`. */
export async function createApplication(options: ApplicationOptions): Promise<Application> {
  const container = options.container ?? new Container();
  const modules = options.modules ?? [];

  const discovered = options.discover === false ? undefined : await loadDiscoveredPackages({ root: options.root });
  const providers: ServiceProviderClass[] = [
    ...((discovered?.providers ?? []) as ServiceProviderClass[]),
    ...(options.providers ?? []),
    ...modules.flatMap((module) => module.providers ?? []),
  ];

  // Configuration from the app, its modules and every provider (packages bring their own).
  const definitions = new Set([
    ...(options.config ?? []),
    ...modules.flatMap((module) => module.config ?? []),
    ...providers.flatMap((Provider) => Provider.config ?? []),
  ]);
  // NODE_ENV resolved once for the process (E170): the environment's, else the app's .env — `bespoke` did it already; a script
  // that boots the app itself gets the same answer here. An app given its own `env` (a test fixture) decides for itself.
  const resolved = options.env ? undefined : resolveEnvironment(options.root);
  const env = options.env ?? loadEnv(options.root);
  const config = await resolveConfig([...definitions], env);
  for (const [definition, value] of config) container.instance(definition, value);

  const app = new Application({ root: options.root, container, modules, packages: discovered?.packages ?? [], options });
  container.instance(Application, app);
  container.instance(Container, container);
  // Fields every log entry carries besides the request's or job's (@bespokecore/otel: the active span's ids).
  container.instance(LogContextSources, new LogContextSources());
  // Fallback until a logging package (e.g. @bespokecore/log) binds its own.
  container.singleton(Logger, () => new ConsoleLogger({}, app));
  // The time (E97); tests bind a `TestClock` they can move.
  container.singleton(Clock, () => new SystemClock());
  // What may be shown or recorded of a value (E125) — packages add names (the session's cookie) while booting.
  container.instance(Redactor, new Redactor());
  // The solutions the development error page shows (E130): every provider's `static solutions` (the specific ones), then the core's.
  container.instance(ErrorSolutions, new ErrorSolutions([...providers.flatMap((Provider) => Provider.solutions ?? []), ...coreSolutions]));
  // The readiness checks of `/up/ready` (E126): the packages' (database, redis, cache, queue), then the app's and its modules'.
  container.instance(
    HealthChecks,
    new HealthChecks([...providers.flatMap((Provider) => Provider.health ?? []), ...(options.health ?? []), ...modules.flatMap((module) => module.health ?? [])]),
  );
  // A defaulted or optional constructor parameter of an injectable type is never injected (E128): said once per class, in
  // development — `container.warnings` keeps them for the error page.
  if (environment.isDevelopment(env)) {
    container.onWarning((warning) => container.make(Logger).warn(`Injection: ${warning.message}`, { class: warning.className }));
  }

  // One registry; a dispatcher per resolution, bound to the asking container (e.g. the request scope).
  const events = new EventRegistry()
    .add(options.listeners ?? [])
    .add(modules.flatMap((module) => module.listeners ?? []));
  container.instance(EventRegistry, events);
  // Queued listeners (E86) go to the app's ListenerQueue (@bespokecore/queue); a test's EventFake sees every event first.
  container.bind(
    EventDispatcher,
    (resolver) =>
      new EventDispatcher(events, resolver, {
        app,
        queue: () => (container.has(ListenerQueue) ? container.make(ListenerQueue) : undefined),
        ...(container.has(EventFake) ? { observer: container.make(EventFake) } : {}),
      }),
  );

  app.register(providers);
  options.override?.(container);
  // A worker of `bespoke start --workers=N` (E140): its primary booted the same app with the same configuration and said the
  // boot's warnings (log mailer, cookies without Secure, stale build artifacts) — the workers keep them to themselves instead of
  // repeating them N times. Warnings after the boot are theirs as always.
  // Only in a worker of node:cluster: the variable left in an operator's environment must not silence a single process.
  const quiet = process.env[CLUSTER_WORKER] === '1' && cluster.isWorker ? quietWhileBooting(container) : undefined;
  try {
    await app.boot();
    // An out-of-date manifest in a read-only .bespoke/ (E160): discovered in memory — said once per process, in the app's log.
    if (discovered?.warning) container.make(Logger).warn(discovered.warning);
    for (const warning of resolved?.warnings ?? []) container.make(Logger).warn(warning);
    // Modules that changed since `bespoke build` (E138): their injection lists were derived at start — said once per process.
    const staleInjections = takeInjectionWarning();
    if (staleInjections) container.make(Logger).warn(staleInjections);
  } finally {
    quiet?.end();
  }
  // A queued listener in an app without a queue fails the start, not its first dispatch.
  const queued = events.all().find((binding) => isQueuedListener(binding.listener));
  if (queued && !container.has(ListenerQueue)) throw new ConfigError(missingListenerQueue(queued.listener as { name: string }));
  return app;
}
