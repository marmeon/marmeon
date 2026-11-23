import type { Application, ServiceProviderClass } from '@marmeon/core';

/** The providers of `app.providers` that the app lists itself: in its definition or in a module, not discovered from a package. */
export function appListedProviders(app: Pick<Application, 'modules' | 'providers' | 'definition'>): ServiceProviderClass[] {
  const own = new Set([...(app.definition.providers ?? []), ...app.modules.flatMap((module) => module.providers ?? [])]);
  return app.providers.filter((provider) => own.has(provider));
}
