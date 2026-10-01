import type { SharedProps } from './page.ts';
import { resolveProp, type SharedValue } from './props.ts';

/**
 * The shared props of the current request (Inertia's `share`). Scoped: middleware
 * shares, the response factory merges the values into every page it renders.
 *
 * A function is evaluated lazily — only when a page is rendered that includes it, never for redirects, JSON or
 * a partial reload that asks for other props — and at most once per request. The wrappers of page props work
 * here too: `share('errors', always(() => …))` is sent with every partial reload.
 *
 * ```ts
 * shared.share('auth', () => ({ user: users.find(session.get('user_id') ?? '') ?? null }));
 * ```
 */
export class SharedData {
  readonly #values = new Map<string, unknown>();
  readonly #resolved = new Map<string, Promise<unknown>>();

  /** Keys and value types are checked against `interface SharedProps`. */
  share<K extends keyof SharedProps & string>(key: K, value: SharedValue<SharedProps[K]>): this {
    this.#values.set(key, value);
    this.#resolved.delete(key);
    return this;
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  /** The shared props as given — lazy and wrapped ones unresolved (what a page's response picks from). */
  entries(): IterableIterator<[string, unknown]> {
    return this.#values.entries();
  }

  /** Resolves the given keys — all of them by default; lazy ones now, each at most once per request. */
  async resolve(keys: Iterable<string> = this.#values.keys()): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      [...keys]
        .filter((key) => this.#values.has(key))
        .map(async (key) => {
          let value = this.#resolved.get(key);
          if (!value) {
            // A second render in the same request (an error page) does not evaluate again.
            value = resolveProp(this.#values.get(key));
            this.#resolved.set(key, value);
          }
          return [key, await value] as const;
        }),
    );
    return Object.fromEntries(entries);
  }
}
