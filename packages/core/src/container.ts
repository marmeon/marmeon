import { describeKey, type Concrete, type Constructor, type InjectCheck, type Key, type Token } from './token.ts';

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

export class ContainerError extends Error {
  override name = 'ContainerError';
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

  make<T>(key: Token<T>): T;
  make<C extends Constructor>(key: C & InjectCheck<C>): InstanceType<C>;
  make(key: Key): unknown {
    return this.#resolve(key, []);
  }

  #resolve(key: Key, path: readonly Key[]): unknown {
    const id = idOf(key);
    if (path.some((seen) => idOf(seen) === id)) {
      throw new ContainerError(`Circular dependency: ${[...path, key].map(describeKey).join(' → ')}.`);
    }
    const chain = [...path, key];
    const binding = this.#findBinding(id);

    if (!binding) {
      if (typeof key === 'function') return this.#build(key as Concrete, chain);
      throw new ContainerError(`No binding for [${describeKey(key)}]${neededBy(path)}. Bind it in a service provider.`);
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
      );
    }
    return new concrete(...(inject ?? []).map((dependency) => this.#resolve(dependency, chain)));
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
