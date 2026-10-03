import { describeKey, type Concrete, type Constructor, type InjectCheck, type Key, type Resolve } from './token.ts';

/** The read side of the container, handed to factories. */
export interface Resolver {
  make<T>(key: Key<T>): T;
}

export type Factory<T> = (resolver: Resolver) => T;

type Lifetime = 'transient' | 'singleton' | 'scoped' | 'instance';

interface Binding {
  readonly lifetime: Lifetime;
  /** The container the binding was registered on; singletons are built and cached there. */
  readonly owner: Container;
  readonly create: (container: Container, path: readonly Key[]) => unknown;
}

const UNRESOLVABLE = Symbol.for('bespokecore.injection.unresolvable');
const WARNINGS = Symbol.for('bespokecore.injection.warnings');

/** Why the container could not resolve something — for messages and the solutions of the error page (E130). */
export type ContainerErrorReason = 'unbound' | 'scoped' | 'no-injection-list' | 'circular';

export interface ContainerErrorDetails {
  readonly reason: ContainerErrorReason;
  /** The binding or class that failed (`Mailer`, `ShowUserController`). */
  readonly key: string;
  /** The chain that asked for it, outermost first (`ShowUserController → UserService`). */
  readonly path: readonly string[];
  /** For `no-injection-list`: why the injection transform could not derive the list, if it said. */
  readonly injection?: string;
}

export class ContainerError extends Error {
  override name = 'ContainerError';
  /** Why it failed — unset for errors built by hand. */
  readonly reason: ContainerErrorReason | undefined;
  /** The binding or class that failed. */
  readonly key: string | undefined;
  /** Who asked for it, outermost first. */
  readonly path: readonly string[];
  /** For `no-injection-list`: the injection transform's reason. */
  readonly injection: string | undefined;

  constructor(message: string, details?: ContainerErrorDetails) {
    super(message);
    this.reason = details?.reason;
    this.key = details?.key;
    this.path = details?.path ?? [];
    this.injection = details?.injection;
  }

  /** `ShowUserController → UserService`, or undefined when it was asked for directly. */
  get neededBy(): string | undefined {
    return this.path.length > 0 ? this.path.join(' → ') : undefined;
  }
}

/**
 * A class the container built whose constructor has a defaulted or optional parameter of an injectable type (E128): the
 * container never injects it — the default applies (or `undefined`). Reported once per class (`Container.onWarning`).
 */
export interface InjectionWarning {
  /** The class's name. */
  readonly className: string;
  /** What the injection transform found, with file, line and parameter. */
  readonly message: string;
}

/**
 * The service container. Resolves classes through their `static inject` list
 * (written by hand, or generated from constructor types — see the roadmap, E1)
 * and interfaces through same-named tokens.
 *
 * Lifetimes:
 * - `bind`      — a new instance on every resolution
 * - `singleton` — one instance, built in the root container
 * - `scoped`    — one instance per scope (per request); resolving it outside a scope is an error
 * - `instance`  — a prebuilt value
 */
export class Container implements Resolver {
  readonly #parent: Container | undefined;
  readonly #bindings = new Map<unknown, Binding>();
  readonly #instances = new Map<unknown, unknown>();
  /** Root only: the classes whose injection warnings were reported, and who hears about them. */
  readonly #warned = new Map<Concrete, InjectionWarning[]>();
  readonly #warningListeners = new Set<(warning: InjectionWarning) => void>();

  constructor(parent?: Container) {
    this.#parent = parent;
  }

  /** A child container for one unit of work (typically a request). Scoped bindings live here. */
  createScope(): Container {
    return new Container(this);
  }

  get isScope(): boolean {
    return this.#parent !== undefined;
  }

  /**
   * Hears about the injection warnings (E128) of classes this container — or a scope of it — builds: a defaulted or
   * optional constructor parameter of an injectable type, which is never injected. Once per class; returns `off`.
   */
  onWarning(listener: (warning: InjectionWarning) => void): () => void {
    const root = this.#root();
    root.#warningListeners.add(listener);
    return () => root.#warningListeners.delete(listener);
  }

  /** The injection warnings (E128) of every class built so far — what the development error page lists. */
  get warnings(): readonly InjectionWarning[] {
    return [...this.#root().#warned.values()].flat();
  }

  #root(): Container {
    let container: Container = this;
    while (container.#parent) container = container.#parent;
    return container;
  }

  // -- Registration ----------------------------------------------------------

  // One signature with a union instead of class/factory overloads: TypeScript only
  // reports the *last* overload's error, which hid why a factory was rejected.
  bind<T, C extends Concrete<NoInfer<T>>>(key: Key<T>, target: Factory<NoInfer<T>> | (C & InjectCheck<C>)): this;
  bind(key: Key, target: Concrete | Factory<unknown>): this {
    return this.#register(key, 'transient', target);
  }

  singleton<C extends Concrete>(concrete: C & InjectCheck<C>): this;
  singleton<T, C extends Concrete<NoInfer<T>>>(key: Key<T>, target: Factory<NoInfer<T>> | (C & InjectCheck<C>)): this;
  singleton(key: Key, target?: Concrete | Factory<unknown>): this {
    return this.#register(key, 'singleton', target ?? (key as Concrete));
  }

  scoped<C extends Concrete>(concrete: C & InjectCheck<C>): this;
  scoped<T, C extends Concrete<NoInfer<T>>>(key: Key<T>, target: Factory<NoInfer<T>> | (C & InjectCheck<C>)): this;
  scoped(key: Key, target?: Concrete | Factory<unknown>): this {
    return this.#register(key, 'scoped', target ?? (key as Concrete));
  }

  instance<T>(key: Key<T>, value: NoInfer<T>): this {
    const id = idOf(key);
    this.#instances.set(id, value);
    this.#bindings.set(id, { lifetime: 'instance', owner: this, create: () => value });
    return this;
  }

  /** Whether `key` is bound here or in a parent. Unbound classes can still be autowired by `make`. */
  has(key: Key): boolean {
    return this.#findBinding(idOf(key)) !== undefined;
  }

  // -- Resolution ------------------------------------------------------------

  /**
   * One signature, not overloads: with overloads, a class failing the `static inject`
   * check would silently fall through to a looser overload. Accepts tokens, classes and
   * `Key<T>` values from generic code; the list check applies whenever K is a class.
   */
  make<K extends Key<any>>(key: K & (K extends Constructor ? InjectCheck<K> : unknown)): Resolve<K> {
    return this.#resolve(key, []) as Resolve<K>;
  }

  #resolve(key: Key, path: readonly Key[]): unknown {
    const id = idOf(key);
    if (path.some((seen) => idOf(seen) === id)) {
      throw new ContainerError(`Circular dependency: ${[...path, key].map(describeKey).join(' → ')}.`, {
        reason: 'circular',
        key: describeKey(key),
        path: path.map(describeKey),
      });
    }
    const chain = [...path, key];
    const binding = this.#findBinding(id);

    if (!binding) {
      if (typeof key === 'function') return this.#build(key as Concrete, chain);
      throw new ContainerError(`No binding for [${describeKey(key)}]${neededBy(path)}. Bind it in a service provider.`, {
        reason: 'unbound',
        key: describeKey(key),
        path: path.map(describeKey),
      });
    }

    switch (binding.lifetime) {
      case 'instance':
        return binding.create(this, chain);

      case 'transient':
        return binding.create(this, chain);

      case 'singleton': {
        // Built in the owning (root) container, so it can never capture request-scoped state.
        const { owner } = binding;
        if (!owner.#instances.has(id)) owner.#instances.set(id, binding.create(owner, chain));
        return owner.#instances.get(id);
      }

      case 'scoped': {
        if (!this.isScope) {
          throw new ContainerError(
            `[${describeKey(key)}] is scoped and can only be resolved inside a scope (e.g. a request)${neededBy(path)}.` +
              (path.length ? ' A singleton must not depend on a scoped service.' : ''),
            { reason: 'scoped', key: describeKey(key), path: path.map(describeKey) },
          );
        }
        if (!this.#instances.has(id)) this.#instances.set(id, binding.create(this, chain));
        return this.#instances.get(id);
      }
    }
  }

  #build(concrete: Concrete, chain: readonly Key[]): unknown {
    const inject = (concrete as { inject?: readonly Key[] }).inject;
    if (inject === undefined && concrete.length > 0) {
      // The injection transform attaches the reason when it could not derive a list.
      const reason = (concrete as unknown as Record<symbol, string | undefined>)[UNRESOLVABLE];
      throw new ContainerError(
        `[${describeKey(concrete)}] needs ${concrete.length} constructor argument(s) but has no injection list` +
          `${neededBy(chain.slice(0, -1))}. ` +
          (reason ??
            'Lists are generated from the constructor types by the BespokeCore loader (app code), ' +
              '"bespoke package:build" or "bespoke discover" (packages).'),
        { reason: 'no-injection-list', key: describeKey(concrete), path: chain.slice(0, -1).map(describeKey), ...(reason ? { injection: reason } : {}) },
      );
    }
    // Inherited with the constructor — unless the class has a list of its own (its own constructor, analyzed by itself).
    const warnings = Object.hasOwn(concrete, WARNINGS) || !Object.hasOwn(concrete, 'inject') ? (concrete as unknown as Record<symbol, readonly string[] | undefined>)[WARNINGS] : undefined;
    if (warnings) this.#warn(concrete, warnings);
    return new concrete(...(inject ?? []).map((dependency) => this.#resolve(dependency, chain)));
  }

  /** Reports a built class's injection warnings (E128) — once per class, on the root. */
  #warn(concrete: Concrete, messages: readonly string[]): void {
    const root = this.#root();
    if (root.#warned.has(concrete)) return;
    const warnings = messages.map((message) => ({ className: describeKey(concrete), message }));
    root.#warned.set(concrete, warnings);
    for (const warning of warnings) for (const listener of root.#warningListeners) listener(warning);
  }

  #register(key: Key, lifetime: Exclude<Lifetime, 'instance'>, target: Concrete | Factory<unknown>): this {
    const create = isClass(target)
      ? (container: Container, chain: readonly Key[]) => container.#build(target, chain)
      : (container: Container, chain: readonly Key[]) =>
          (target as Factory<unknown>)({ make: (dependency) => container.#resolve(dependency, chain) as never });

    const id = idOf(key);
    this.#instances.delete(id); // re-binding replaces a cached singleton
    this.#bindings.set(id, { lifetime, owner: this, create });
    return this;
  }

  #findBinding(id: unknown): Binding | undefined {
    const parent = this.#parent;
    return this.#bindings.get(id) ?? (parent ? parent.#findBinding(id) : undefined);
  }
}

function idOf(key: Key): unknown {
  return typeof key === 'function' ? key : key.key;
}

function neededBy(path: readonly Key[]): string {
  return path.length ? ` (needed by ${path.map(describeKey).join(' → ')})` : '';
}

/** Native classes stringify as `class …`; factories are arrow or plain functions. */
function isClass(target: Concrete | Factory<unknown>): target is Concrete {
  return /^class[\s{]/.test(Function.prototype.toString.call(target));
}
