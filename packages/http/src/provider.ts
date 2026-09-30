import type { Application, Container, ServiceProvider } from '@bespokecore/core';
import { Router, type RouteDefinitions } from '@bespokecore/router';
import { DefaultExceptionHandler, ExceptionHandler } from './errors.ts';

declare module '@bespokecore/core' {
  interface ModuleDefinition {
    /** The module's routes, loaded into the router when the application boots. */
    readonly routes?: RouteDefinitions;
  }
}

/**
 * Registers the router and the exception handler, and loads every module's
 * routes — Laravel's RouteServiceProvider. Discovered like any installed package through the
 * `"bespoke"` field in this package's package.json.
 */
export class HttpServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(Router);
    container.singleton(ExceptionHandler, DefaultExceptionHandler);
  }

  boot(app: Application): void {
    const router = app.container.make(Router);
    for (const module of app.modules) {
      if (module.routes) router.load(module.routes);
    }
  }
}
