import cluster from 'node:cluster';
import { ConfigError, invalidConfiguration, loadEnv, validateConfig, type ConfigDefinition } from './config/config.ts';
import { EnvironmentConfig } from './config/environment-config.ts';
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
 * What an app boots for. `run` — serving, working a queue, a command: every configuration validated, every provider
 * registered and booted. `build` — what `marmeon build` needs of the app (the route types): every provider registered, **none
 * booted** (no connection, no check of a driver), and configuration that does not validate — the runtime secrets: `APP_KEY`,
 * database passwords, mail credentials — left out instead of failing: reading it then throws. So the build needs no `.env`
 * and no secret, and none can end up in what it writes.
 */
export type ApplicationPhase = 'run' | 'build';

/**
 * How an app is defined — what ships. Packages add their own app-level settings through declaration merging, like
 * `ModuleDefinition` (http adds `middleware`). What only a boot decides — the environment, the phase, test doubles — is
 * not part of it: see {@link CreateApplicationOptions}.
 */
export interface ApplicationDefinition {
  /** App root: package.json, `.marmeon/`, `index.html`. */
  root: string;
  /** Feature modules, in the order they should register and boot. */
  modules?: readonly ModuleDefinition[];
  /** Extra app-level providers (booted after packages, before modules). */
  providers?: readonly ServiceProviderClass[];
  /** App-level event listeners; modules bring their own through `listeners`. */
  listeners?: readonly ListenerBinding[];
  /** App-level configuration; modules can contribute their own through `config`. */
  config?: readonly ConfigDefinition<any>[];
  /** App-level readiness checks for `/up/ready`; packages and modules bring their own through `health`. */
  health?: readonly HealthCheckClass[];
  /** Register providers of installed packages (`marmeon discover`). Default: true. */
  discover?: boolean;
}

/**
 * What a boot decides, apart from the definition. Kept out of {@link ApplicationDefinition} on purpose: an `override`
 * (test doubles) or a foreign `env` in the definition that ships would replace bindings or configuration in production.
 */
export interface CreateApplicationOptions {
  /**
   * Environment to validate the configuration against. Default: `.env`, then
   * `.env.{NODE_ENV}`, then the real environment (which wins).
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * `build`: registered, not booted, without the configuration that does not validate — what `marmeon build` boots the
   * app with (`static boots = 'build'` on a built-in command). Default: `run`.
   */
  phase?: ApplicationPhase;
  /** The container to bind into. Default: a new one. */
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
export function defineApplication(definition: ApplicationDefinition): ApplicationDefinition {
  return definition;
}

/**
 * The application: owns the container, the modules and the provider lifecycle.
 *
 * Configuration is validated and bound first — a start with missing or invalid
 * variables fails before anything else runs, listing every problem at once.
 *
 * Boot order — every provider registers before any provider boots:
 * 1. providers of installed packages (dependencies first, from `marmeon discover`)
 * 2. app-level providers
 * 3. module providers, in module order
 */
export class Application {
  readonly root: string;
  readonly container: Container;
  readonly modules: readonly ModuleDefinition[];
  /** Names of the installed packages whose providers were discovered. */
  readonly packages: readonly string[];
  /**
   * The provider classes in register order: the packages', the app's, the modules'. Set before any provider registers, so
   * one may read the others' static lists in `register()`.
   */
  readonly providers: readonly ServiceProviderClass[];
  /** What the app was defined with — packages read their app-level settings from here (e.g. http's `middleware`). */
  readonly definition: ApplicationDefinition;
  /** `build`: registered, never booted — see {@link ApplicationPhase}. */
  readonly phase: ApplicationPhase;
  readonly #providers: ServiceProvider[] = [];
  #shutdown: Promise<void> | undefined;

  /** @internal `createApplication()` builds the app; nothing else does. */
  constructor(options: {
    root: string;
    container: Container;
    modules: readonly ModuleDefinition[];
    packages: readonly string[];
    providers?: readonly ServiceProviderClass[];
    definition?: ApplicationDefinition;
    phase?: ApplicationPhase;
  }) {
    this.root = options.root;
    this.container = options.container;
    this.modules = options.modules;
    this.packages = options.packages;
    this.providers = options.providers ?? [];
    this.definition = options.definition ?? { root: options.root };
    this.phase = options.phase ?? 'run';
  }

  /** @internal Register phase: build each provider through the container and let it bind services. `createApplication()` calls it; an app never does. */
  register(providers: readonly ServiceProviderClass[]): void {
    // A provider may also only bring configuration (`static config`, validated earlier), health checks, solutions or commands.
    for (const Provider of providers) {
      const provider = this.container.make(Provider);
      const hooks = [provider.register, provider.boot, provider.shutdown].some((hook) => typeof hook === 'function');
      if (!hooks && !Provider.config?.length && !Provider.health?.length && !Provider.solutions?.length && !declaredCommands(Provider) && !declaredDrivers(Provider)) {
        throw new TypeError(`${Provider.name} is listed as a service provider but has no register(), boot(), shutdown(), static config, static health, static solutions, static commands, ${DRIVER_STATICS.map((key) => `static ${key}`).join(', ').replace(/, ([^,]*)$/, ' or $1')}.`);
      }
      provider.register?.(this.container);
      this.#providers.push(provider);
    }
  }

  /** @internal Boot phase: runs once every provider has registered. `createApplication()` calls it; an app never does. */
  async boot(): Promise<void> {
    if (this.phase === 'build') throw new Error('An app in the build phase is never booted: createApplication(definition, { phase: \'build\' }) registers its providers only.');
    for (const provider of this.#providers) await provider.boot?.(this);
  }

  /**
   * Stops the app: every provider's `shutdown`, in reverse order (a provider shuts down
   * before the ones it was booted after). Runs once — later calls return the same promise.
   * Every provider gets its turn even if an earlier one fails; failures are thrown together.
   *
   * The CLI calls it after a command, the server on SIGINT/SIGTERM, tests via `await using`. An app in the build phase never booted and
   * opened nothing: no provider's `shutdown` runs.
   */
  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      const errors: unknown[] = [];
      for (const provider of this.phase === 'build' ? [] : this.#providers.toReversed()) {
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

/** Set by the primary of `marmeon start --workers=N` for its workers: the boot's warnings were said once, by the primary. */
export const CLUSTER_WORKER = 'MARMEON_CLUSTER_WORKER';

/**
 * The statics a package's provider lists drivers in — each service package adds its own through declaration merging — and
 * `migrationUpgrades`, the revisions of its tables.
 */
const DRIVER_STATICS = ['queueDrivers', 'failedJobDrivers', 'diskDrivers', 'cacheDrivers', 'migrationUpgrades'] as const;

/** Whether `Provider` brings drivers of any service or revisions of its tables: a non-empty record or list in one of the {@link DRIVER_STATICS}. */
function declaredDrivers(Provider: ServiceProviderClass): boolean {
  return DRIVER_STATICS.some((key) => {
    const record = (Provider as unknown as Record<string, unknown>)[key];
    return typeof record === 'object' && record !== null && Object.keys(record).length > 0;
  });
}

/** Whether `Provider` lists commands — a static list the marmeon CLI declares on `ServiceProviderClass`. */
function declaredCommands(Provider: ServiceProviderClass): boolean {
  return ((Provider as { commands?: readonly unknown[] }).commands?.length ?? 0) > 0;
}

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
    enabled: (level) => (level === 'warn' && booting ? false : (inner.enabled?.(level) ?? true)),
  });
  container.instance(Logger, quiet(logger));
  return {
    end: () => {
      booting = false;
    },
  };
}

/** The keys of {@link CreateApplicationOptions}: never part of a definition. */
const BOOT_OPTIONS = ['env', 'phase', 'container', 'override'] as const;

/**
 * Creates and boots the application from its definition — the composition root of `bootstrap/app.ts`. The boot options
 * (`env`, `phase`, `container`, `override`) are what tests and scripts decide; the definition never carries them: one that
 * does — also by a spread, which the types cannot see — is refused, so no test double or foreign environment ships.
 */
export async function createApplication(definition: ApplicationDefinition, options: CreateApplicationOptions = {}): Promise<Application> {
  for (const key of BOOT_OPTIONS) {
    if (key in definition) throw new TypeError(`\`${key}\` is a boot option: pass it as createApplication(definition, { ${key} }), not in the definition.`);
  }
  const container = options.container ?? new Container();
  const modules = definition.modules ?? [];

  const discovered = definition.discover === false ? undefined : await loadDiscoveredPackages({ root: definition.root });
  const providers: ServiceProviderClass[] = [
    ...((discovered?.providers ?? []) as ServiceProviderClass[]),
    ...(definition.providers ?? []),
    ...modules.flatMap((module) => module.providers ?? []),
  ];

  // Configuration from the app, its modules and every provider (packages bring their own) — and the environment, every app's.
  const definitions = new Set([
    EnvironmentConfig,
    ...(definition.config ?? []),
    ...modules.flatMap((module) => module.config ?? []),
    ...providers.flatMap((Provider) => Provider.config ?? []),
  ]);
  // NODE_ENV resolved once for the process: the environment's, else the app's .env — `marmeon` did it already; a script
  // that boots the app itself gets the same answer here. An app given its own `env` (a test fixture) decides for itself.
  const resolved = options.env ? undefined : resolveEnvironment(definition.root);
  const env = options.env ?? loadEnv(definition.root);
  // An unknown NODE_ENV stops the start before anything asks it — also for an app given its own `env`.
  environment.check(env);
  const phase = options.phase ?? 'run';
  const { resolved: config, problems } = await validateConfig([...definitions], env);
  if (problems.size > 0 && phase === 'run') throw invalidConfiguration(problems);
  for (const [definition, value] of config) container.instance(definition, value);
  // The build phase goes on without them — the runtime secrets a build has no business with. Whoever reads one learns why.
  for (const [definition, issues] of problems) {
    container.bind(definition, () => {
      throw unavailableWhileBuilding(definition, issues);
    });
  }

  const app = new Application({ root: definition.root, container, modules, packages: discovered?.packages ?? [], providers: Object.freeze([...providers]), definition, phase });
  container.instance(Application, app);
  container.instance(Container, container);
  // Fields every log entry carries besides the request's or job's (@marmeon/otel: the active span's ids).
  container.instance(LogContextSources, new LogContextSources());
  // Fallback until a logging package (e.g. @marmeon/log) binds its own.
  container.singleton(Logger, () => new ConsoleLogger({}, app));
  container.singleton(Clock, () => new SystemClock());
  // What may be shown or recorded of a value — packages add names (the session's cookie) while booting.
  container.instance(Redactor, new Redactor());
  // The solutions the development error page shows: every provider's `static solutions` (the specific ones), then the core's.
  container.instance(ErrorSolutions, new ErrorSolutions([...providers.flatMap((Provider) => Provider.solutions ?? []), ...coreSolutions]));
  // The readiness checks of `/up/ready`: the packages' (database, redis, cache, queue), then the app's and its modules'.
  container.instance(
    HealthChecks,
    new HealthChecks([...providers.flatMap((Provider) => Provider.health ?? []), ...(definition.health ?? []), ...modules.flatMap((module) => module.health ?? [])]),
  );
  // A defaulted or optional constructor parameter of an injectable type is never injected: said once per class, in
  // development — `container.warnings` keeps them for the error page.
  if (environment.isDevelopment(env)) {
    container.onWarning((warning) => container.make(Logger).warn(`Injection: ${warning.message}`, { class: warning.className }));
  }

  // One registry; a dispatcher per resolution, bound to the asking container (e.g. the request scope).
  const events = new EventRegistry()
    .add(definition.listeners ?? [])
    .add(modules.flatMap((module) => module.listeners ?? []));
  container.instance(EventRegistry, events);
  // Queued listeners go to the app's ListenerQueue (@marmeon/queue); a test's EventFake sees every event first.
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
  // The build phase ends here: registered, not booted — no connection, no driver check, no secret needed.
  if (phase === 'build') return app;
  // A worker of `marmeon start --workers=N` keeps the boot's warnings to itself: its primary said them once. Only in a
  // node:cluster worker — the variable left in an operator's environment must not silence a single process.
  const quiet = process.env[CLUSTER_WORKER] === '1' && cluster.isWorker ? quietWhileBooting(container) : undefined;
  try {
    await app.boot();
    // An out-of-date manifest in a read-only .marmeon/: discovered in memory — said once per process, in the app's log.
    if (discovered?.warning) container.make(Logger).warn(discovered.warning);
    for (const warning of resolved?.warnings ?? []) container.make(Logger).warn(warning);
    // Modules that changed since `marmeon build`: their injection lists were derived at start — said once per process.
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

/** Reading configuration the build phase left out: which variables, and why the build does not have them. */
function unavailableWhileBuilding(definition: ConfigDefinition<unknown>, issues: readonly string[]): ConfigError {
  const error = new ConfigError(
    `The configuration "${definition.name}" is not available while building — the build boots the app without runtime secrets:\n${issues.join('\n')}\n` +
      'Read it when the app runs (in boot(), a request, a job, a command) — not while a provider registers or the build runs.',
  );
  error.stack = `${error.name}: ${error.message}`;
  return error;
}
