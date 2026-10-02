import type { DeepPartial, FieldOf, IslandNameOf, IslandPropsOf, PageNameOf, PageSource, PropsOf, TestResponse } from './response.ts';
import type { CheckFlashKey, FlashValue, LayerClose, RegionOutcomeStatus } from '@bespokecore/http/page';

type Assertions = {
  [K in keyof TestResponse as TestResponse[K] extends (...args: any[]) => TestResponse ? K : never]: TestResponse[K];
};

/**
 * A request that has not been awaited yet. Assertions chained onto it run once it
 * is awaited, so a whole check reads like Laravel:
 *
 * ```ts
 * await app.get('/users/1').assertOk().assertPage('user-profile/Show');
 * ```
 */
export class PendingTestResponse implements PromiseLike<TestResponse> {
  readonly #response: Promise<TestResponse>;
  readonly #assertions: ((response: TestResponse) => void)[] = [];

  constructor(response: Promise<TestResponse>) {
    this.#response = response;
  }

  then<TResult1 = TestResponse, TResult2 = never>(
    onfulfilled?: ((value: TestResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#response
      .then((response) => {
        for (const assertion of this.#assertions) assertion(response);
        return response;
      })
      .then(onfulfilled, onrejected);
  }

  #queue(assertion: (response: TestResponse) => void): this {
    this.#assertions.push(assertion);
    return this;
  }

  assertStatus(...args: Parameters<Assertions['assertStatus']>): this {
    return this.#queue((r) => r.assertStatus(...args));
  }
  assertOk(): this {
    return this.#queue((r) => r.assertOk());
  }
  assertServerRendered(): this {
    return this.#queue((r) => r.assertServerRendered());
  }
  assertHydrates(): this {
    return this.#queue((r) => r.assertHydrates());
  }
  assertSuccessful(): this {
    return this.#queue((r) => r.assertSuccessful());
  }
  assertCreated(): this {
    return this.#queue((r) => r.assertCreated());
  }
  assertNoContent(): this {
    return this.#queue((r) => r.assertNoContent());
  }
  assertUnauthorized(): this {
    return this.#queue((r) => r.assertUnauthorized());
  }
  assertForbidden(): this {
    return this.#queue((r) => r.assertForbidden());
  }
  assertNotFound(): this {
    return this.#queue((r) => r.assertNotFound());
  }
  assertUnprocessable(): this {
    return this.#queue((r) => r.assertUnprocessable());
  }
  assertRedirect(...args: Parameters<Assertions['assertRedirect']>): this {
    return this.#queue((r) => r.assertRedirect(...args));
  }
  assertActionRedirect(...args: Parameters<Assertions['assertActionRedirect']>): this {
    return this.#queue((r) => r.assertActionRedirect(...args));
  }
  /** See {@link TestResponse.assertFlash} — typed by the app's `FlashData`. */
  assertFlash<const K extends string>(key: CheckFlashKey<K>, data?: DeepPartial<FlashValue<K>>): this {
    return this.#queue((r) => r.assertFlash<K>(key, data));
  }
  /** See {@link TestResponse.assertFlashed}. */
  assertFlashed<const K extends string>(key: CheckFlashKey<K>, data?: DeepPartial<FlashValue<K>>): this {
    return this.#queue((r) => r.assertFlashed<K>(key, data));
  }
  assertNoFlash(...args: Parameters<Assertions['assertNoFlash']>): this {
    return this.#queue((r) => r.assertNoFlash(...args));
  }
  assertCookie(...args: Parameters<Assertions['assertCookie']>): this {
    return this.#queue((r) => r.assertCookie(...args));
  }
  assertCookieMissing(...args: Parameters<Assertions['assertCookieMissing']>): this {
    return this.#queue((r) => r.assertCookieMissing(...args));
  }
  assertCookieExpired(...args: Parameters<Assertions['assertCookieExpired']>): this {
    return this.#queue((r) => r.assertCookieExpired(...args));
  }
  assertSessionHas(...args: Parameters<Assertions['assertSessionHas']>): this {
    return this.#queue((r) => r.assertSessionHas(...args));
  }
  assertSessionMissing(...args: Parameters<Assertions['assertSessionMissing']>): this {
    return this.#queue((r) => r.assertSessionMissing(...args));
  }
  assertAuthenticated(...args: Parameters<Assertions['assertAuthenticated']>): this {
    return this.#queue((r) => r.assertAuthenticated(...args));
  }
  assertGuest(): this {
    return this.#queue((r) => r.assertGuest());
  }
  assertInvalid<C = unknown>(fields: readonly FieldOf<C>[] | Partial<Record<FieldOf<C>, string | RegExp>>): this {
    return this.#queue((r) => r.assertInvalid<C>(fields));
  }
  assertValid(): this {
    return this.#queue((r) => r.assertValid());
  }
  assertHeader(...args: Parameters<Assertions['assertHeader']>): this {
    return this.#queue((r) => r.assertHeader(...args));
  }
  assertJson(...args: Parameters<Assertions['assertJson']>): this {
    return this.#queue((r) => r.assertJson(...args));
  }
  assertExactJson(...args: Parameters<Assertions['assertExactJson']>): this {
    return this.#queue((r) => r.assertExactJson(...args));
  }
  assertSee(...args: Parameters<Assertions['assertSee']>): this {
    return this.#queue((r) => r.assertSee(...args));
  }
  assertDontSee(...args: Parameters<Assertions['assertDontSee']>): this {
    return this.#queue((r) => r.assertDontSee(...args));
  }
  assertPage<TSource extends PageSource = PageSource, const V extends string = string>(
    component: PageNameOf<TSource, V>,
    props?: DeepPartial<PropsOf<TSource>> | ((props: PropsOf<TSource>) => void),
  ): this {
    return this.#queue((r) => r.assertPage<TSource, V>(component, props));
  }
  assertIsland<TSource extends { handle: (...args: never[]) => unknown } = { handle: (...args: never[]) => unknown }, const V extends string = string>(
    component: IslandNameOf<TSource, V>,
    props?: DeepPartial<IslandPropsOf<TSource>> | ((props: IslandPropsOf<TSource>) => void),
  ): this {
    return this.#queue((r) => r.assertIsland<TSource, V>(component, props));
  }
  assertIslandStatus(status: RegionOutcomeStatus): this {
    return this.#queue((r) => r.assertIslandStatus(status));
  }
  assertLayer<TSource extends PageSource = PageSource, const V extends string = string>(
    component: PageNameOf<TSource, V>,
    props?: DeepPartial<PropsOf<TSource>> | ((props: PropsOf<TSource>) => void),
  ): this {
    return this.#queue((r) => r.assertLayer<TSource, V>(component, props));
  }
  assertLayerClosed(expected?: Partial<LayerClose>): this {
    return this.#queue((r) => r.assertLayerClosed(expected));
  }
}
