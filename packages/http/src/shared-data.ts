import type { SharedProps } from './page.ts';

type Lazy<T> = T | (() => T | Promise<T>);

/**
 * The shared props of the current request (Inertia's `share`). Scoped: middleware
 * shares, the response factory merges the values into every page it renders.
 *
 * A function is evaluated lazily — only when a page is rendered, never for
 * redirects or JSON — and at most once per request.
 *
 * ```ts
 * shared.share('auth', () => ({ user: users.find(session.get('user_id') ?? '') ?? null }));
 * ```
 */
export class SharedData {
  readonly #values = new Map<string, Lazy<unknown>>();

  /** Keys and value types are checked against `interface SharedProps`. */
  share<K extends keyof SharedProps & string>(key: K, value: Lazy<SharedProps[K]>): this {
    this.#values.set(key, value);
    return this;
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  /** Resolves every value (lazy ones now). */
  async resolve(): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      [...this.#values].map(async ([key, value]) => {
        const resolved = typeof value === 'function' ? await (value as () => unknown)() : value;
        this.#values.set(key, resolved); // a second render in the same request does not evaluate again
        return [key, resolved] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
}
