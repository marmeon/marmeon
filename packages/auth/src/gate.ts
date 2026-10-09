import { HttpError, type ClassResolver, type HttpContext, type JoinNames } from '@marmeon/router';
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
    super(status, status === 404 ? undefined : (message ?? 'This action is unauthorized.'), {}, fallback ? { key: 'marmeon.errors.unauthorized' } : undefined);
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

type PolicyMethod = (user: AuthUser, ...resources: unknown[]) => PolicyResult | Promise<PolicyResult>;

/** Abilities of `P` a projection can answer for one resource: they take one resource besides the user, or none. */
export type ProjectableAbility<P> = {
  [K in AbilityOf<P>]: ResourcesOf<P, K> extends [] | [unknown] | [unknown?] ? K : never;
}[AbilityOf<P>];

/** Abilities of `P` that take no resource (`create(user)`) — projected with `gate.abilities(Policy, names)`. */
export type ResourcelessAbility<P> = { [K in AbilityOf<P>]: [] extends ResourcesOf<P, K> ? K : never }[AbilityOf<P>];

type Contravariant<T> = T extends unknown ? (resource: T) => void : never;

/** The resource that fits every ability in `K` — what their policy methods take after the user (an intersection). */
export type ResourceOf<P, K extends keyof P> = (
  K extends unknown ? Contravariant<ResourcesOf<P, K> extends [] ? unknown : ResourcesOf<P, K> extends [(infer R)?] ? R : never> : never
) extends (resource: infer R) => void
  ? R
  : never;

/**
 * `K` when a projection can ask it — otherwise the message: not an ability (with the policy's abilities), one that needs
 * its resource, or one that takes more than one.
 */
export type CheckAbility<P, K extends string, Allowed extends string, Missing extends string> = string extends K
  ? Allowed
  : K extends Allowed
    ? K
    : K extends AbilityOf<P>
      ? K extends ProjectableAbility<P>
        ? `'${K}' ${Missing}`
        : `'${K}' takes more than one resource — a projection asks one; use gate.allows(Policy, '${K}', …)`
      : `'${K}' is not an ability of this policy — it has ${JoinNames<AbilityOf<P>>}`;

/** The projection's answer: one boolean per named ability — never the policy's reasons. */
export type Abilities<K extends string> = { [N in K]: boolean };

/** A row with its abilities: `{ ...row, can: { delete: boolean } }`. */
export type WithAbilities<T, K extends string> = { [F in keyof T as F extends 'can' ? never : F]: T[F] } & { can: Abilities<K> } extends infer R
  ? { [F in keyof R]: R[F] }
  : never;

type Projectable<P, K> = Extract<K, ProjectableAbility<P>>;

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

/** Tells a request's gate the user the token guard authenticated — set once below, by the class itself. */
let setTokenUser: (gate: Gate, user: AuthUser) => void;

/**
 * Asks policies (E28): explicitly named, type-checked, no string gates — Laravel's `Gate`, per request.
 *
 * ```ts
 * if (await this.#gate.allows(ProfilePolicy, 'update', profile)) …
 * await this.#gate.authorize(ProfilePolicy, 'update', profile);   // or 403 / 404
 * ```
 *
 * The user is the session's — or, on a route behind `authenticate('api')`, the token's user: the token guard tells the
 * request's gate. Guests are denied before any policy runs. A policy's `before(user, ability)` may decide first
 * (`true`/`false`); `undefined` lets the ability decide.
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

  constructor(auth: Auth, resolve: ClassResolver) {
    this.#auth = auth;
    this.#resolve = resolve;
  }

  /** Whom the policies are asked about: the token's user on an API route, else the session's. */
  #user(): Promise<AuthUser | undefined> {
    return this.#tokenUser === undefined ? this.#auth.user() : Promise.resolve(this.#tokenUser);
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
    const user = await this.#user();
    if (user === undefined) return new PolicyResponse(false);
    const instance = this.#resolve(policy) as P & Before;
    const method = instance[ability] as unknown;
    if (typeof method !== 'function') throw new TypeError(`${policy.name} has no ability "${ability}".`);
    if (instance.before) {
      const early = await instance.before(user, ability);
      if (typeof early === 'boolean') return new PolicyResponse(early);
    }
    const result = (await (method as PolicyMethod).call(instance, user, ...resources)) as PolicyResult;
    return result instanceof PolicyResponse ? result : new PolicyResponse(result === true);
  }

  /**
   * What the page may offer for `resource` (E61) — one boolean per named ability, from the policy:
   *
   * ```ts
   * abilities: this.#gate.abilities(profile, ProfilePolicy, ['update']),   // the view: abilities.update
   * abilities: this.#gate.abilities(PostPolicy, ['create']),              // abilities without a resource
   * ```
   *
   * Explicit: nothing is asked that is not named, and only booleans leave the server (never a `deny()` reason).
   * Lazy: as a page prop it runs only when the response includes it — a partial reload for other props skips it,
   * and so does a reload of the data it is about; name it, or project it inside that prop (`profile: async () =>
   * ({ ...profile, can: await gate.abilities(…) })`), to refresh it with the data.
   *
   * The UI's hint only: the server checks again on every request (`can()` in `authorize`, `gate.authorize`).
   */
  abilities<P extends object, const K extends string>(
    policy: PolicyClass<P>,
    names: readonly CheckAbility<P, K, ResourcelessAbility<P>, `needs its resource — gate.abilities(resource, Policy, ['${K}'])`>[],
  ): Projection<Abilities<K>>;
  abilities<P extends object, const K extends string>(
    resource: NoInfer<ResourceOf<P, Projectable<P, K>>>,
    policy: PolicyClass<P>,
    names: readonly CheckAbility<P, K, ProjectableAbility<P>, never>[],
  ): Projection<Abilities<K>>;
  abilities(...args: [PolicyClass, readonly string[]] | [unknown, PolicyClass, readonly string[]]): Projection<Abilities<string>> {
    const [resources, policy, names] = args.length === 2 ? [[], args[0], args[1]] : [[args[0]], args[1], args[2]];
    return projection(async () => (await this.#project(policy, names, [resources]))[0]!);
  }

  /**
   * Each row with its abilities (E61): `{ ...link, can: { delete: boolean } }` — for lists, where every row is
   * asked on its own:
   *
   * ```ts
   * links: this.#gate.withAbilities(links, ProfileLinkPolicy, ['delete']),   // the view: link.can.delete
   * ```
   *
   * The cost, honestly: the policy method runs once per row and named ability (50 rows, one ability: 50 calls) —
   * cheap for a comparison, a query per row for a policy that queries (load what it needs with the rows instead).
   * `before()` runs once per ability for the whole list, the policy is built once, and abilities not named never run.
   * Lazy like {@link Gate.abilities}.
   */
  withAbilities<P extends object, const K extends string, T extends ResourceOf<P, Projectable<P, K>>>(
    rows: readonly T[],
    policy: PolicyClass<P>,
    names: readonly CheckAbility<P, K, ProjectableAbility<P>, never>[],
  ): Projection<WithAbilities<T, K>[]> {
    return projection(async () => {
      const answers = await this.#project(policy, names, rows.map((row) => [row]));
      return rows.map((row, index) => ({ ...(row as object), can: answers[index]! }) as unknown as WithAbilities<T, K>);
    });
  }

  /** One answer per resource list: the user and the policy once, `before()` once per ability, then every method call. */
  async #project(policy: PolicyClass, names: readonly string[], resources: readonly unknown[][]): Promise<Abilities<string>[]> {
    const denied = () => Object.fromEntries(names.map((name) => [name, false]));
    if (resources.length === 0) return [];
    const user = await this.#user();
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
