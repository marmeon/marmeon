import type { Application } from './application.ts';
import type { ConfigDefinition } from './config/config.ts';
import type { Container } from './container.ts';
import type { HealthCheckClass } from './health.ts';
import type { SolutionDefinition } from './solutions.ts';

/**
 * Registers and boots a module's or package's services.
 *
 * `register` binds things into the container and must not resolve anything yet,
 * because other providers may not have registered. `boot` runs after *every*
 * provider has registered, so it may resolve freely. `shutdown` releases what the
 * provider holds (connection pools, file handles) when the app stops — in reverse
 * boot order, so a provider still has everything it depends on.
 */
export interface ServiceProvider {
  register?(container: Container): void;
  boot?(app: Application): void | Promise<void>;
  shutdown?(app: Application): void | Promise<void>;
}

/**
 * A provider class. Packages declare the configuration they need as
 * `static config = [LogConfig]`; it is validated with the app's own config,
 * before any provider registers. `static solutions` lists the solutions for the package's errors that the development
 * error page shows (`defineSolutions`); `static health` the package's readiness checks for `/up/ready`.
 */
export type ServiceProviderClass = (new (...args: any[]) => ServiceProvider) & {
  readonly config?: readonly ConfigDefinition<any>[];
  readonly solutions?: readonly SolutionDefinition<any>[];
  readonly health?: readonly HealthCheckClass[];
};
