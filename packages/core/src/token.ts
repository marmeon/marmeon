/**
 * A runtime handle for a type that has no runtime value (interfaces, config shapes).
 * By convention it shares its name with the interface, so one import yields both:
 *
 * ```ts
 * export interface Mailer { send(to: string): Promise<void> }
 * export const Mailer = token<Mailer>('Mailer');
 * ```
 */
export interface Token<T> {
  readonly key: symbol;
  readonly name: string;
  /** Phantom field: only exists for the type checker, keeps `Token<A>` and `Token<B>` apart. */
  readonly __type?: T;
}

export function token<T>(name: string): Token<T> {
  return Object.freeze({ key: Symbol(name), name });
}

/** Any class, including abstract ones — usable as a binding key. */
export type Constructor<T = unknown> = abstract new (...args: any[]) => T;

/** A class the container can instantiate. */
export type Concrete<T = unknown> = new (...args: any[]) => T;

/** What can be bound and resolved: a class or a token. */
export type Key<T = unknown> = Token<T> | Constructor<T>;

export type Resolve<K> = K extends Token<infer T> ? T : K extends Constructor<infer T> ? T : never;

type ResolveAll<Keys extends readonly unknown[]> = { -readonly [I in keyof Keys]: Resolve<Keys[I]> };

/**
 * Checks an explicit `static inject` list against the constructor. The resolved
 * list is compared as a *tuple*, so every position is checked covariantly — a
 * missing, extra or swapped dependency is a compile error.
 */
export type InjectCheck<C> = C extends { readonly inject: infer Keys extends readonly Key<any>[] }
  ? C extends abstract new (...args: infer Params) => unknown
    ? ResolveAll<Keys> extends Params
      ? unknown
      : { readonly 'static inject does not match the constructor': { constructor: Params; inject: ResolveAll<Keys> } }
    : unknown
  : unknown;

export function describeKey(key: Key): string {
  return typeof key === 'function' ? key.name || '(anonymous class)' : key.name;
}
