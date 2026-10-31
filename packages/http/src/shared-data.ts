import type { SharedProps } from './page.ts';
import { resolveProp, type SharedValue } from './props.ts';
import { checkedChannel, type LiveDeclaration, type LiveOnly } from './live.ts';

/**
 * The shared props of the current request, scoped: middleware shares, the response factory merges the
 * values into every page it renders. A function is evaluated only when a page that includes it renders, at most once per
 * request; the wrappers of page props work here too. See docs/responses.md#shared-props.
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
   * A live channel every page follows, for shared props a layout shows — a channel, or a function of the request that returns
   * one (`undefined`: follow nothing). Signed into every page this request renders — never into an island or a layer, which show
   * no layout. Needs @marmeon/live. See docs/realtime.md#shared-props.
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

  /** @internal — the live channels shared with every page, as declared. */
  liveChannels(): readonly LiveDeclaration[] {
    return this.#live;
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  /** @internal — the shared props as given: lazy and wrapped ones unresolved (what a page's response picks from). */
  entries(): IterableIterator<[string, unknown]> {
    return this.#values.entries();
  }

  /** @internal — resolves the given keys, all of them by default; lazy ones now, each at most once per request. */
  async resolve(keys: Iterable<string> = this.#values.keys()): Promise<Record<string, unknown>> {
    // Every prop settles before the first failure is thrown (in key order): a page that fails while another prop is still
    // running would leave that prop's work, and its rejection, behind the response.
    const settled = await Promise.allSettled(
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
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return Object.fromEntries(settled.map((result) => (result as PromiseFulfilledResult<readonly [string, unknown]>).value));
  }
}
