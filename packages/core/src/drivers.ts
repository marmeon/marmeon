import type { ServiceProviderClass } from './provider.ts';

const NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The drivers that `providers` bring through a static record (`static queueDrivers = { sqs: factory }`), by name. Fails —
 * and so stops the start — for a name that is not lowercase letters, digits and dashes, one of the `builtIn` names (a package
 * never replaces a driver the framework ships), the same name from two providers, or a value that is not a function.
 * `what` names the kind in messages (`queue driver`).
 */
export function collectDrivers<F extends (...args: any[]) => unknown>(
  providers: readonly ServiceProviderClass[],
  key: string,
  builtIn: readonly string[],
  what: string,
): ReadonlyMap<string, F> {
  const drivers = new Map<string, F>();
  const owners = new Map<string, { provider: string; record: unknown }>();
  const seen = new Set<ServiceProviderClass>();
  for (const Provider of providers) {
    if (seen.has(Provider)) continue;
    seen.add(Provider);
    const record = (Provider as unknown as Record<string, unknown>)[key];
    if (record === undefined) continue;
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new TypeError(`${Provider.name}.${key} must be an object of ${what} factories by name: static ${key} = { name: factory }.`);
    }
    for (const [name, factory] of Object.entries(record)) {
      if (!NAME.test(name)) {
        throw new TypeError(`${Provider.name} brings a ${what} named "${name}", but a name is lowercase letters, digits and dashes, starting with a letter.`);
      }
      if (builtIn.includes(name)) {
        throw new TypeError(`${Provider.name} brings a ${what} named "${name}", but that name belongs to the built-in one. Built-in names: ${builtIn.join(', ')}. Choose another name.`);
      }
      if (typeof factory !== 'function') {
        throw new TypeError(`${Provider.name}.${key}.${name} must be a function that creates the ${what}.`);
      }
      const first = owners.get(name);
      if (first !== undefined) {
        throw new TypeError(`The ${what} "${name}" is brought by both ${first.provider} and ${Provider.name} — one name, one driver. Rename one of them${first.record === record ? ' (both read one static record: a provider class that extends another inherits its static ' + key + ' — list only one of the two, or give the subclass its own record)' : ''}.`);
      }
      owners.set(name, { provider: Provider.name, record });
      drivers.set(name, factory as F);
    }
  }
  return drivers;
}
