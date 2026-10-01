import { HttpError, type ClassResolver, type HttpContext } from '@bespokecore/router';
import { Auth } from './auth.ts';
import type { AuthUser, Authenticated } from './user.ts';

/** What a policy method may answer besides `true`/`false`: a reason, or "pretend it does not exist". */
export class PolicyResponse {
  readonly #response = true;
  readonly allowed: boolean;
  /** 403, or 404 for `denyAsNotFound()` — the client cannot tell a hidden record from a missing one. */
  readonly status: 403 | 404;
  readonly message: string | undefined;

  constructor(allowed: boolean, status: 403 | 404 = 403, message?: string) {
    this.allowed = allowed;
    this.status = status;
    this.message = message;
  }
}

export type PolicyResult = boolean | PolicyResponse;

export function allow(): PolicyResponse {
  return new PolicyResponse(true);
}

/** Denied (403) — with a reason the client may see: `deny('Only the author can edit this.')`. */
export function deny(message?: string): PolicyResponse {
  return new PolicyResponse(false, 403, message);
}

/** Denied, answered like a record that does not exist (404, same body) — for things others must not even know about. */
export function denyAsNotFound(): PolicyResponse {
  return new PolicyResponse(false, 404);
}

/** A denied ability — 403 (with the policy's reason) or 404. */
export class AuthorizationError extends HttpError {
  override name = 'AuthorizationError';

  constructor(status: 403 | 404 = 403, message?: string) {
    // The policy's own reason is the app's text (translated by the app); the default is a framework text by key.
    const fallback = status === 403 && message === undefined;
    super(status, status === 404 ? undefined : (message ?? 'This action is unauthorized.'), {}, fallback ? { key: 'bespoke.errors.unauthorized' } : undefined);
  }
}

/**
 * The methods of policy `P` that are abilities: `(user, …resources) => boolean | PolicyResponse`
 * (sync or async). `before` is a hook, not an ability.
 */
export type AbilityOf<P> = Exclude<
  {
    [K in keyof P]: P[K] extends (user: AuthUser, ...resources: any[]) => PolicyResult | Promise<PolicyResult> ? K : never;
  }[keyof P],
  'before'
> &
  string;

/** What ability `K` of policy `P` needs besides the user. */
export type ResourcesOf<P, K extends keyof P> = P[K] extends (user: AuthUser, ...resources: infer R) => unknown ? R : never;

/** A policy class — an ordinary injectable class (it may use repositories). */
export type PolicyClass<P = object> = new (...args: any[]) => P;

interface Before {
  before?(user: AuthUser, ability: string): boolean | undefined | void | Promise<boolean | undefined | void>;
}

/**
 * Asks policies (E28): explicitly named, type-checked, no string gates — Laravel's `Gate`, per request.
 *
 * ```ts
 * if (await this.#gate.allows(ProfilePolicy, 'update', profile)) …
 * await this.#gate.authorize(ProfilePolicy, 'update', profile);   // or 403 / 404
 * ```
 *
 * Guests are denied before any policy runs. A policy's `before(user, ability)` may decide first
 * (`true`/`false`); `undefined` lets the ability decide.
 */
export class Gate {
  readonly #auth: Auth;
  readonly #resolve: ClassResolver;

  constructor(auth: Auth, resolve: ClassResolver) {
    this.#auth = auth;
    this.#resolve = resolve;
  }

  async allows<P extends object, K extends AbilityOf<P>>(policy: PolicyClass<P>, ability: K, ...resources: ResourcesOf<P, K>): Promise<boolean> {
    return (await this.inspect(policy, ability, ...resources)).allowed;
  }

  async denies<P extends object, K extends AbilityOf<P>>(policy: PolicyClass<P>, ability: K, ...resources: ResourcesOf<P, K>): Promise<boolean> {
    return !(await this.allows(policy, ability, ...resources));
  }

  /** Throws `AuthorizationError` (403, or 404 for `denyAsNotFound()`) unless allowed. */
  async authorize<P extends object, K extends AbilityOf<P>>(policy: PolicyClass<P>, ability: K, ...resources: ResourcesOf<P, K>): Promise<void> {
    const response = await this.inspect(policy, ability, ...resources);
    if (!response.allowed) throw new AuthorizationError(response.status, response.message);
  }

  /** The policy's full answer. */
  async inspect<P extends object, K extends AbilityOf<P>>(policy: PolicyClass<P>, ability: K, ...resources: ResourcesOf<P, K>): Promise<PolicyResponse> {
    const user = await this.#auth.user();
    if (user === undefined) return new PolicyResponse(false);
    const instance = this.#resolve(policy) as P & Before;
    const method = instance[ability] as unknown;
    if (typeof method !== 'function') throw new TypeError(`${policy.name} has no ability "${ability}".`);
    if (instance.before) {
      const early = await instance.before(user, ability);
      if (typeof early === 'boolean') return new PolicyResponse(early);
    }
    const result = (await (method as (user: AuthUser, ...resources: unknown[]) => PolicyResult | Promise<PolicyResult>).call(instance, user, ...resources)) as PolicyResult;
    return result instanceof PolicyResponse ? result : new PolicyResponse(result === true);
  }
}

/** Where `can()` finds the resource: a bound route parameter by name, or a function of the context. */
type ResourceSource<R, TParams extends object> = keyof TParams | ((ctx: HttpContext<Authenticated, TParams>) => R);

/**
 * A request's `authorize`, asking a policy — after route binding, so it sees the bound record (E28):
 *
 * ```ts
 * authorize: can(ProfilePolicy, 'update', 'user'),   // ctx.params.user, typed by the route's binding
 * ```
 *
 * The route must provide what the policy needs: a parameter bound to the wrong type, or not bound at
 * all (a string), is a compile error where the controller is registered. Abilities without a resource
 * take no third argument. Denials throw `AuthorizationError`, so `denyAsNotFound()` answers 404.
 */
export function can<P extends object, K extends AbilityOf<P>>(
  policy: PolicyClass<P>,
  ability: K,
  ...resource: ResourcesOf<P, K> extends [] ? [] : [resource: `"${K}" needs its resource: a bound route parameter's name, or (ctx) => resource`]
): (ctx: HttpContext<Authenticated>, resolve: ClassResolver) => Promise<boolean>;
export function can<P extends object, K extends AbilityOf<P>, const N extends string>(
  policy: PolicyClass<P>,
  ability: K,
  param: N,
): (ctx: HttpContext<Authenticated, { [Name in N]: ResourcesOf<P, K>[0] }>, resolve: ClassResolver) => Promise<boolean>;
export function can<P extends object, K extends AbilityOf<P>, TParams extends object>(
  policy: PolicyClass<P>,
  ability: K,
  resource: (ctx: HttpContext<Authenticated, TParams>) => ResourcesOf<P, K>[0],
): (ctx: HttpContext<Authenticated, TParams>, resolve: ClassResolver) => Promise<boolean>;
export function can(policy: PolicyClass, ability: string, ...source: [ResourceSource<unknown, Record<string, unknown>>?]) {
  return async (ctx: HttpContext<Authenticated, Record<string, unknown>>, resolve: ClassResolver) => {
    const [from] = source;
    const resources = from === undefined ? [] : [typeof from === 'function' ? from(ctx) : ctx.params[from as string]];
    await (resolve(Gate).authorize as (policy: PolicyClass, ability: string, ...resources: unknown[]) => Promise<void>)(policy, ability, ...resources);
    return true;
  };
}
