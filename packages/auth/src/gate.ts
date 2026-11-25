import { environment, Logger } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { describeAccess, HttpError, type ClassResolver, type HttpContext, type JoinNames } from '@marmeon/router';
import { Auth } from './auth.ts';
import { logQuietly } from './quiet-log.ts';
import { policyGuard, type PolicyUser } from './policy-guard.ts';
import { RequestGuard } from './request-guard.ts';
import type { AuthUser } from './user.ts';

/** What a policy method may answer besides `true`/`false`: a reason, or "pretend it does not exist". */
export class PolicyResponse {
  readonly #response = true;
  readonly allowed: boolean;
  /** 403, or 404 for `denyAsNotFound()` — the client cannot tell a hidden record from a missing one. */
  readonly status: 403 | 404;
  readonly message: string | undefined;

  /** @internal Made by `allow()`, `deny()` and `denyAsNotFound()`. */
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
    super(status, status === 404 ? undefined : (message ?? 'This action is unauthorized.'), {}, fallback ? { key: 'marmeon.errors.unauthorized' } : undefined);
  }
}

/** Whether the policy method `M` takes the user type `U` (checked strictly: a method for one guard's users never answers for another's; `never` is no user). */
type Takes<M, U> = M extends (user: infer X, ...resources: any[]) => PolicyResult | Promise<PolicyResult> ? ([U] extends [never] ? false : [U] extends [X] ? true : false) : false;

/**
 * The methods of policy `P` that are abilities: `(user, …resources) => boolean | PolicyResponse` (sync or async), with the user type
 * `U` of the policy's guard. `before` is a hook, not an ability.
 */
export type AbilityOf<P, U = AuthUser> = Exclude<{ [K in keyof P]: [Takes<P[K], U>] extends [true] ? K : never }[keyof P], 'before'> & string;

/** What ability `K` of policy `P` needs besides the user. */
export type ResourcesOf<P, K extends keyof P, U = AuthUser> = P[K] extends (user: U, ...resources: infer R) => unknown ? R : never;

/** A policy class — an ordinary injectable class (it may use repositories). */
export type PolicyClass<P = object> = new (...args: any[]) => P;

interface Before {
  before?(user: any, ability: string): boolean | undefined | void | Promise<boolean | undefined | void>;
}

type PolicyMethod = (user: any, ...resources: unknown[]) => PolicyResult | Promise<PolicyResult>;

/** Abilities of `P` a projection can answer for one resource: they take one resource besides the user, or none. */
export type ProjectableAbility<P, U = AuthUser> = {
  [K in AbilityOf<P, U>]: ResourcesOf<P, K, U> extends [] | [unknown] | [unknown?] ? K : never;
}[AbilityOf<P, U>];

/** Abilities of `P` that take no resource (`create(user)`) — projected with `gate.abilities(Policy, names)`. */
export type ResourcelessAbility<P, U = AuthUser> = { [K in AbilityOf<P, U>]: [] extends ResourcesOf<P, K, U> ? K : never }[AbilityOf<P, U>];

type Contravariant<T> = T extends unknown ? (resource: T) => void : never;

/** The resource that fits every ability in `K` — what their policy methods take after the user (an intersection). */
export type ResourceOf<P, K extends keyof P, U = AuthUser> = (
  K extends unknown ? Contravariant<ResourcesOf<P, K, U> extends [] ? unknown : ResourcesOf<P, K, U> extends [(infer R)?] ? R : never> : never
) extends (resource: infer R) => void
  ? R
  : never;

/**
 * `K` when a projection can ask it — otherwise the message: not an ability (with the policy's abilities), one that needs
 * its resource, or one that takes more than one.
 */
export type CheckAbility<P, K extends string, Allowed extends string, Missing extends string, U = AuthUser> = string extends K
  ? Allowed
  : K extends Allowed
    ? K
    : K extends AbilityOf<P, U>
      ? K extends ProjectableAbility<P, U>
        ? `'${K}' ${Missing}`
        : `'${K}' takes more than one resource — a projection asks one; use gate.allows(Policy, '${K}', …)`
      : `'${K}' is not an ability of this policy — it has ${JoinNames<AbilityOf<P, U>>}`;

/** The projection's answer: one boolean per named ability — never the policy's reasons. */
export type Abilities<K extends string> = { [N in K]: boolean };

/** A row with its abilities: `{ ...row, can: { delete: boolean } }`. */
export type WithAbilities<T, K extends string> = { [F in keyof T as F extends 'can' ? never : F]: T[F] } & { can: Abilities<K> } extends infer R
  ? { [F in keyof R]: R[F] }
  : never;

type Projectable<P, K, U> = Extract<K, ProjectableAbility<P, U>>;

/**
 * A projection, computed when it is first asked for — and then once: as a page prop it is a lazy prop (a partial
 * reload that asks for other props never runs a policy), `await` it for its value anywhere else.
 */
export interface Projection<T> extends PromiseLike<T> {
  (): Promise<T>;
}

function projection<T>(compute: () => Promise<T>): Projection<T> {
  let answer: Promise<T> | undefined;
  const run = () => (answer ??= compute());
  // oxlint-disable-next-line unicorn/no-thenable -- a projection is awaitable on purpose (PromiseLike)
  return Object.assign(run, { then: <A = T, B = never>(fulfilled?: ((value: T) => A | PromiseLike<A>) | null, rejected?: ((reason: unknown) => B | PromiseLike<B>) | null) => run().then(fulfilled, rejected) });
}

/** The guard of a policy that names none: the app's. */
const APP_GUARD = 'web';

/** The route guards each policy class was already warned about, per process. */
const WARNED = new WeakMap<object, Set<string>>();

/** Tells a request's gate the user the token guard authenticated — set once below, by the class itself. */
let setTokenUser: (gate: Gate, user: AuthUser) => void;

/**
 * Asks policies for this request: explicitly named and type-checked, no string gates —
 * `await this.#gate.authorize(ProfilePolicy, 'update', profile)`. A policy judges the users of its own guard (`static guard`, the app's
 * without one): the session's user, or on a route behind `authenticate('api')` the token's, or the signed-in user of its package guard;
 * guests are denied before any policy runs. See `docs/authorization.md#the-gate` and `docs/authorization.md#policies-of-a-guard`.
 */
export class Gate {
  readonly #auth: Auth;
  readonly #resolve: ClassResolver;
  /** The user of this request's API token — set by the token guard, never by app code. */
  #tokenUser: AuthUser | undefined;

  static {
    setTokenUser = (gate, user) => {
      gate.#tokenUser = user;
    };
  }

  /** @internal Built by the container. */
  constructor(auth: Auth, resolve: ClassResolver) {
    this.#auth = auth;
    this.#resolve = resolve;
  }

  /**
   * The user `policy` is asked about, `undefined` for a guest and for a policy this request's route does not allow: on a route that belongs
   * to another guard than the policy's the answer is no, never yes. Deliberately "no" and not an error, so one global middleware that asks a
   * policy cannot take down every route of another guard. Then the policy is not built, `before()` does not run and no user is loaded. The
   * order is fixed: a static that names no registered guard (A8), the route's guard, then the user, always of the policy's own guard.
   */
  async #subject(policy: PolicyClass, method: string): Promise<object | undefined> {
    const guard = policyGuard(policy, this.#resolve);
    const name = guard?.name ?? APP_GUARD;
    // Read through the resolver, the request's scope in the container. Nobody but the binding can make a RequestGuard, so a resolver
    // that has none throws here rather than answering with an empty stamp that every check passes.
    const request = this.#resolve(RequestGuard);
    if (!request.admit(name)) {
      this.#warnForeign(policy, method, name, request.name ?? APP_GUARD);
      return undefined;
    }
    if (guard === undefined) return this.#tokenUser ?? (await this.#auth.user());
    return await this.#resolve(guard.Auth).user();
  }

  /** In development, once per policy class and route guard and process: which policy was told no, by which gate method, for which two guards. */
  #warnForeign(policy: PolicyClass, method: string, policyGuardName: string, routeGuard: string): void {
    if (!environment.isDevelopment()) return;
    const seen = WARNED.get(policy) ?? new Set<string>();
    if (seen.has(routeGuard)) return;
    const said = logQuietly(
      this.#resolve(Logger),
      'warn',
      withCode(
        'A9',
        `${policy.name || 'A policy'} judges the users of the guard '${policyGuardName}', but Gate.${method}() asked it on a route of the guard '${routeGuard}': the answer is no. ` +
          'See docs/authorization.md#policies-of-a-guard.',
      ),
    );
    // A sink that threw said nothing: the next check tries again.
    if (said) WARNED.set(policy, seen.add(routeGuard));
  }

  async allows<P extends object, K extends AbilityOf<P, PolicyUser<C>>, C extends PolicyClass<P> = PolicyClass<P>>(policy: C & PolicyClass<P>, ability: K, ...resources: ResourcesOf<P, K, PolicyUser<C>>): Promise<boolean> {
    return (await this.#inspect('allows', policy, ability, resources)).allowed;
  }

  async denies<P extends object, K extends AbilityOf<P, PolicyUser<C>>, C extends PolicyClass<P> = PolicyClass<P>>(policy: C & PolicyClass<P>, ability: K, ...resources: ResourcesOf<P, K, PolicyUser<C>>): Promise<boolean> {
    return !(await this.#inspect('denies', policy, ability, resources)).allowed;
  }

  /** Throws `AuthorizationError` (403, or 404 for `denyAsNotFound()`) unless allowed. */
  async authorize<P extends object, K extends AbilityOf<P, PolicyUser<C>>, C extends PolicyClass<P> = PolicyClass<P>>(policy: C & PolicyClass<P>, ability: K, ...resources: ResourcesOf<P, K, PolicyUser<C>>): Promise<void> {
    const response = await this.#inspect('authorize', policy, ability, resources);
    if (!response.allowed) throw new AuthorizationError(response.status, response.message);
  }

  /** The policy's full answer. */
  async inspect<P extends object, K extends AbilityOf<P, PolicyUser<C>>, C extends PolicyClass<P> = PolicyClass<P>>(policy: C & PolicyClass<P>, ability: K, ...resources: ResourcesOf<P, K, PolicyUser<C>>): Promise<PolicyResponse> {
    return this.#inspect('inspect', policy, ability, resources);
  }

  async #inspect(method: string, policy: PolicyClass, ability: string, resources: readonly unknown[]): Promise<PolicyResponse> {
    const user = await this.#subject(policy, method);
    if (user === undefined) return new PolicyResponse(false);
    const instance = this.#resolve(policy) as Record<string, unknown> & Before;
    const ask = instance[ability];
    if (typeof ask !== 'function') throw new TypeError(`${policy.name} has no ability "${ability}".`);
    if (instance.before) {
      const early = await instance.before(user, ability);
      if (typeof early === 'boolean') return new PolicyResponse(early);
    }
    const result = (await (ask as PolicyMethod).call(instance, user, ...resources)) as PolicyResult;
    return result instanceof PolicyResponse ? result : new PolicyResponse(result === true);
  }

  /**
   * What the page may offer for `resource`: one boolean per named ability — `abilities(profile, ProfilePolicy, ['update'])`.
   * Only named abilities are asked, only booleans leave the server (never a `deny()` reason), and as a page prop it runs only
   * when the response includes it. A hint for the UI: the server checks again on every request. See
   * `docs/authorization.md#abilities-for-the-page`.
   */
  abilities<P extends object, const K extends string, C extends PolicyClass<P> = PolicyClass<P>>(
    policy: C & PolicyClass<P>,
    names: readonly CheckAbility<P, K, ResourcelessAbility<P, PolicyUser<C>>, `needs its resource — gate.abilities(resource, Policy, ['${K}'])`, PolicyUser<C>>[],
  ): Projection<Abilities<K>>;
  abilities<P extends object, const K extends string, C extends PolicyClass<P> = PolicyClass<P>>(
    resource: NoInfer<ResourceOf<P, Projectable<P, K, PolicyUser<C>>, PolicyUser<C>>>,
    policy: C & PolicyClass<P>,
    names: readonly CheckAbility<P, K, ProjectableAbility<P, PolicyUser<C>>, never, PolicyUser<C>>[],
  ): Projection<Abilities<K>>;
  abilities(...args: [PolicyClass, readonly string[]] | [unknown, PolicyClass, readonly string[]]): Projection<Abilities<string>> {
    const [resources, policy, names] = args.length === 2 ? [[], args[0], args[1]] : [[args[0]], args[1], args[2]];
    return projection(async () => (await this.#project('abilities', policy, names, [resources]))[0]!);
  }

  /**
   * Each row with its abilities: `{ ...link, can: { delete: boolean } }`. The policy runs once per row and named ability — a
   * query per row for a policy that queries, so load what it needs with the rows. Lazy like {@link Gate.abilities}; see
   * `docs/authorization.md#abilities-for-the-page`.
   */
  withAbilities<P extends object, const K extends string, T extends ResourceOf<P, Projectable<P, K, PolicyUser<C>>, PolicyUser<C>>, C extends PolicyClass<P> = PolicyClass<P>>(
    rows: readonly T[],
    policy: C & PolicyClass<P>,
    names: readonly CheckAbility<P, K, ProjectableAbility<P, PolicyUser<C>>, never, PolicyUser<C>>[],
  ): Projection<WithAbilities<T, K>[]> {
    return projection(async () => {
      const answers = await this.#project('withAbilities', policy, names, rows.map((row) => [row]));
      return rows.map((row, index) => ({ ...(row as object), can: answers[index]! }) as unknown as WithAbilities<T, K>);
    });
  }

  /** One answer per resource list: the user and the policy once, `before()` once per ability, then every method call. */
  async #project(method: 'abilities' | 'withAbilities', policy: PolicyClass, names: readonly string[], resources: readonly unknown[][]): Promise<Abilities<string>[]> {
    const denied = () => Object.fromEntries(names.map((name) => [name, false]));
    if (resources.length === 0) return [];
    // Where the projection is computed, not where it was asked for: the page renders after the middleware, the stamp is set by then.
    const user = await this.#subject(policy, method);
    if (user === undefined) return resources.map(denied);
    const instance = this.#resolve(policy) as Record<string, unknown> & Before;
    for (const name of names) if (typeof instance[name] !== 'function') throw new TypeError(`${policy.name} has no ability "${name}".`);
    const early = new Map<string, boolean>();
    if (instance.before) {
      for (const name of names) {
        const answer = await instance.before(user, name);
        if (typeof answer === 'boolean') early.set(name, answer);
      }
    }
    const answers: Abilities<string>[] = [];
    // One after another: a policy that queries must not open a connection per row at once.
    for (const args of resources) {
      const answer: Abilities<string> = {};
      for (const name of names) {
        const decided = early.get(name);
        const result = decided ?? ((await (instance[name] as PolicyMethod).call(instance, user, ...args)) as PolicyResult);
        answer[name] = result instanceof PolicyResponse ? result.allowed : result === true;
      }
      answers.push(answer);
    }
    return answers;
  }
}

/** The token guard's word to this request's gate: the user its API token belongs to (the gate's policies see them). */
export function authenticatedByToken(gate: Gate, user: AuthUser): void {
  setTokenUser(gate, user);
}

/** Where `can()` finds the resource: a bound route parameter by name, or a function of the context. */
type ResourceSource<R, TParams extends object> = keyof TParams | ((ctx: HttpContext<{ readonly user: unknown }, TParams>) => R);

/**
 * A request's `authorize`, asking a policy after route binding — `authorize: can(ProfilePolicy, 'update', 'user')`.
 * A parameter bound to the wrong type, or not bound at all, is a compile error where the controller is registered, and so is a route
 * whose `ctx.user` is not a user of the guard the policy judges. Denials throw `AuthorizationError`, so `denyAsNotFound()` answers 404.
 * See `docs/authorization.md#every-route-decides`.
 */
export function can<P extends object, K extends AbilityOf<P, PolicyUser<C>>, C extends PolicyClass<P> = PolicyClass<P>>(
  policy: C & PolicyClass<P>,
  ability: K,
  ...resource: ResourcesOf<P, K, PolicyUser<C>> extends [] ? [] : [resource: `"${K}" needs its resource: a bound route parameter's name, or (ctx) => resource`]
): (ctx: HttpContext<{ readonly user: PolicyUser<C> }>, resolve: ClassResolver) => Promise<boolean>;
export function can<P extends object, K extends AbilityOf<P, PolicyUser<C>>, const N extends string, C extends PolicyClass<P> = PolicyClass<P>>(
  policy: C & PolicyClass<P>,
  ability: K,
  param: N,
): (ctx: HttpContext<{ readonly user: PolicyUser<C> }, { [Name in N]: ResourcesOf<P, K, PolicyUser<C>>[0] }>, resolve: ClassResolver) => Promise<boolean>;
export function can<P extends object, K extends AbilityOf<P, PolicyUser<C>>, TParams extends object, C extends PolicyClass<P> = PolicyClass<P>>(
  policy: C & PolicyClass<P>,
  ability: K,
  resource: (ctx: HttpContext<{ readonly user: PolicyUser<C> }, TParams>) => ResourcesOf<P, K, PolicyUser<C>>[0],
): (ctx: HttpContext<{ readonly user: PolicyUser<C> }, TParams>, resolve: ClassResolver) => Promise<boolean>;
export function can(policy: PolicyClass, ability: string, ...source: [any?]): (ctx: any, resolve: ClassResolver) => Promise<boolean> {
  const [from] = source as [ResourceSource<unknown, Record<string, unknown>>?];
  const check = async (ctx: HttpContext<{ readonly user: unknown }, Record<string, unknown>>, resolve: ClassResolver) => {
    const resources = from === undefined ? [] : [typeof from === 'function' ? from(ctx) : ctx.params[from as string]];
    await (resolve(Gate).authorize as (policy: PolicyClass, ability: string, ...resources: unknown[]) => Promise<void>)(policy, ability, ...resources);
    return true;
  };
  // What `route:list` shows: the parameter's name, `…` for a function, nothing without a resource.
  const resource = from === undefined ? '' : typeof from === 'function' ? '(…)' : `(${String(from)})`;
  return describeAccess(check, `can ${policy?.name || 'Policy'}.${String(ability)}${resource}`);
}
