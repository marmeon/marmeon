import type { Application } from './application.ts';
import type { Container } from './container.ts';

/**
 * Registers and boots a module's or package's services — Laravel's ServiceProvider.
 *
 * `register` binds things into the container and must not resolve anything yet,
 * because other providers may not have registered. `boot` runs after *every*
 * provider has registered, so it may resolve freely.
 */
export interface ServiceProvider {
  register?(container: Container): void;
  boot?(app: Application): void | Promise<void>;
}

export type ServiceProviderClass = new (...args: any[]) => ServiceProvider;
