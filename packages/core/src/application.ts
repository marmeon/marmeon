import { Container } from './container.ts';
import { loadDiscoveredPackages } from './discovery/discover.ts';
import type { ModuleDefinition } from './module.ts';
import type { ServiceProvider, ServiceProviderClass } from './provider.ts';

export interface ApplicationOptions {
  /** App root: package.json, `.bespoke/`, `index.html`. */
  root: string;
  /** Feature modules, in the order they should register and boot. */
  modules?: readonly ModuleDefinition[];
  /** Extra app-level providers (booted after packages, before modules). */
  providers?: readonly ServiceProviderClass[];
  /** Register providers of installed packages (`bespoke discover`). Default: true. */
  discover?: boolean;
  container?: Container;
}

/**
 * The application: owns the container, the modules and the provider lifecycle.
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
  readonly #providers: ServiceProvider[] = [];

  constructor(options: { root: string; container: Container; modules: readonly ModuleDefinition[]; packages: readonly string[] }) {
    this.root = options.root;
    this.container = options.container;
    this.modules = options.modules;
    this.packages = options.packages;
  }

  /** Register phase: build each provider through the container and let it bind services. */
  register(providers: readonly ServiceProviderClass[]): void {
    for (const Provider of providers) {
      const provider = this.container.make(Provider);
      if (typeof provider.register !== 'function' && typeof provider.boot !== 'function') {
        throw new TypeError(`${Provider.name} is listed as a service provider but has neither register() nor boot().`);
      }
      provider.register?.(this.container);
      this.#providers.push(provider);
    }
  }

  /** Boot phase: runs once every provider has registered. */
  async boot(): Promise<void> {
    for (const provider of this.#providers) await provider.boot?.(this);
  }
}

/** Creates and boots the application — the composition root of `bootstrap/app.ts`. */
export async function createApplication(options: ApplicationOptions): Promise<Application> {
  const container = options.container ?? new Container();
  const modules = options.modules ?? [];
  const discovered = options.discover === false ? undefined : await loadDiscoveredPackages({ root: options.root });

  const app = new Application({ root: options.root, container, modules, packages: discovered?.packages ?? [] });
  container.instance(Application, app);
  container.instance(Container, container);

  app.register([
    ...((discovered?.providers ?? []) as ServiceProviderClass[]),
    ...(options.providers ?? []),
    ...modules.flatMap((module) => module.providers ?? []),
  ]);
  await app.boot();
  return app;
}
