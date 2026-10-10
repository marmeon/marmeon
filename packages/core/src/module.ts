import type { ConfigDefinition } from './config/config.ts';
import type { ListenerBinding } from './events.ts';
import type { HealthCheckClass } from './health.ts';
import type { ServiceProviderClass } from './provider.ts';

/**
 * A feature module of the modular monolith. Core knows only its name and
 * providers; other packages add what they contribute through declaration merging:
 *
 * ```ts
 * // in @marmeon/http
 * declare module '@marmeon/core' {
 *   interface ModuleDefinition { readonly routes?: RouteDefinitions }
 * }
 * ```
 */
export interface ModuleDefinition {
  readonly name: string;
  readonly providers?: readonly ServiceProviderClass[];
  /** Validated and bound before any provider registers. */
  readonly config?: readonly ConfigDefinition<any>[];
  /** Event listeners, e.g. `[listen(UserLoggedIn, RecordLastLogin)]`. */
  readonly listeners?: readonly ListenerBinding[];
  /** Readiness checks for `/up/ready`: `[StorageWritable]` — classes with `static check` and `handle()`. */
  readonly health?: readonly HealthCheckClass[];
}

/** Declares a module. The identity function exists for type inference and discoverability. */
export function defineModule<const TModule extends ModuleDefinition>(module: TModule): TModule {
  return module;
}
