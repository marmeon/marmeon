import type { Container } from './container.ts';

/**
 * Registers a module's or package's services. Minimal for now — the full
 * register → boot lifecycle arrives with the Application (Wave 1, step 5).
 */
export interface ServiceProvider {
  register(container: Container): void;
}

/** Builds each provider through the container (so providers get injection too) and registers it. */
export function registerProviders(container: Container, providers: readonly (new (...args: any[]) => unknown)[]): void {
  for (const Provider of providers) {
    const provider = container.make(Provider) as Partial<ServiceProvider>;
    if (typeof provider.register !== 'function') {
      throw new TypeError(`${Provider.name} is listed as a service provider but has no register(container) method.`);
    }
    provider.register(container);
  }
}
