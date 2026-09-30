import type { AnyAction, AnyMiddleware, HttpMethod } from './types.ts';

/**
 * A single registered route (Laravel's `Illuminate\Routing\Route`).
 * Created by the `Route` registrar; only its name remains mutable after registration.
 */
export class RouteDefinition {
  readonly methods: readonly HttpMethod[];
  readonly path: string;
  readonly action: AnyAction;
  readonly middleware: readonly AnyMiddleware[];
  readonly #namePrefix: string;
  #name: string | undefined;

  constructor(options: {
    methods: readonly HttpMethod[];
    path: string;
    action: AnyAction;
    middleware: readonly AnyMiddleware[];
    namePrefix: string;
  }) {
    this.methods = options.methods;
    this.path = options.path;
    this.action = options.action;
    this.middleware = options.middleware;
    this.#namePrefix = options.namePrefix;
  }

  /** Names the route, prepending any group name prefix: `name('show')` in `name('profile.')` -> `profile.show`. */
  name(name: string): this {
    this.#name = this.#namePrefix + name;
    return this;
  }

  get routeName(): string | undefined {
    return this.#name;
  }
}
