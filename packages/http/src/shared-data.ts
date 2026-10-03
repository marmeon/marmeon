import type { SharedProps } from './page.ts';
import { resolveProp, type SharedValue } from './props.ts';
import { checkedChannel, type LiveDeclaration, type LiveOnly } from './live.ts';

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
  readonly #live: LiveDeclaration[] = [];

  /** Keys and value types are checked against `interface SharedProps`. */
  share<K extends keyof SharedProps & string>(key: K, value: SharedValue<SharedProps[K]>): this {
    this.#values.set(key, value);
    this.#resolved.delete(key);
    return this;
  }

  /**
   * A live channel every page follows (W6.10) — for shared props, which every page's layout shows: the bell's count reloads
   * when the server hints that the signed-in user's notifications changed.
   *
   * ```ts
   * shared.live(async () => {
   *   const user = await auth.user();
   *   return user ? notificationsChannel({ type: 'user', id: user.id }) : undefined;   // a guest follows nothing
   * }, { only: ['bell'] });
   * ```
   *
   * The channel (or a function of the request that says which — evaluated only when a page renders) is signed into every
   * page this request renders (never into an island or a layer, which show no layout). Needs @bespokecore/live.
   */
  live<const O extends readonly string[] = readonly []>(
    channel: string | (() => string | undefined | Promise<string | undefined>),
    options: { readonly only?: LiveOnly<O, keyof SharedProps & string, 'the shared props'> } = {},
  ): this {
    const where = 'shared.live()';
    if (typeof channel !== 'function') checkedChannel(channel, where);
    const only = options.only as unknown;
    if (only !== undefined && (!Array.isArray(only) || !only.every((name) => typeof name === 'string' && name !== ''))) {
      throw new TypeError(`${where}: only is a list of shared prop names, got ${JSON.stringify(only)}.`);
    }
    this.#live.push({ channel, ...(only ? { only: [...(only as string[])] } : {}) });
    return this;
  }

  /** The live channels shared with every page, as declared. */
  liveChannels(): readonly LiveDeclaration[] {
    return this.#live;
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
