import { providerJobs, type Application, type ServiceProviderClass } from '@marmeon/core';

/** The providers of `app.providers` that the app lists itself: in its definition or in a module, not discovered from a package. */
export function appListedProviders(app: Pick<Application, 'modules' | 'providers' | 'definition'>): ServiceProviderClass[] {
  const own = new Set([...(app.definition.providers ?? []), ...app.modules.flatMap((module) => module.providers ?? [])]);
  return app.providers.filter((provider) => own.has(provider));
}

/**
 * The jobs a provider lists in its `static [providerJobs]`, read through the prototype chain: a subclass inherits the list.
 * Anything that is not an array, or a read that throws, is no list. The items are not checked; a caller reads only what it needs of each.
 * @internal
 */
export function providerJobsOf(provider: unknown): readonly unknown[] {
  try {
    const jobs: unknown = (provider as { [providerJobs]?: unknown } | null | undefined)?.[providerJobs];
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    // A getter that throws is no list: the listing must not fail for one provider.
    return [];
  }
}
