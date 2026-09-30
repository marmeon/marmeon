import { AssertionError, deepStrictEqual, partialDeepStrictEqual } from 'node:assert';
import { isPageObject, PAGE_SCRIPT_ID, type PageObject, type PageProps } from '@bespokecore/http/page';
import type { CookieCrypto } from './test-app.ts';

/** Something `PageProps` can infer from: a controller class instance or a route closure. */
export type PageSource = { handle: (...args: never[]) => unknown } | ((...args: never[]) => unknown);

/** Props of a page, every level optional — for asserting a subset. */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Typed props when a controller is given (`assertPage<ShowUserController>`), any record otherwise. */
export type PropsOf<TSource extends PageSource> = PageSource extends TSource ? Record<string, unknown> : PageProps<TSource>;

const PAGE_SCRIPT = new RegExp(`<script type="application/json" id="${PAGE_SCRIPT_ID}">([\\s\\S]*?)</script>`);

/**
 * A response with Laravel-style assertions. The body is read up front, so every
 * assertion is synchronous and can be chained.
 */
export class TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  readonly #label: string;
  /** Cookie values as the app meant them — decrypted. */
  readonly #cookies: ReadonlyMap<string, string>;

  constructor(response: Response, body: string, label: string, cookies: ReadonlyMap<string, string> = new Map()) {
    this.status = response.status;
    this.headers = response.headers;
    this.body = body;
    this.#label = label;
    this.#cookies = cookies;
  }

  static async from(response: Response, label: string, crypto?: CookieCrypto): Promise<TestResponse> {
    const cookies = new Map<string, string>();
    for (const header of response.headers.getSetCookie()) {
      const { name, value } = splitSetCookie(header);
      cookies.set(name, crypto ? await crypto.decrypt(name, value) : value);
    }
    return new TestResponse(response, await response.text(), label, cookies);
  }

  // --- Accessors ----------------------------------------------------------------

  json<T = unknown>(): T {
    try {
      return JSON.parse(this.body) as T;
    } catch {
      this.#fail('Expected a JSON response');
    }
  }

  /** The page object — from a client-side navigation (JSON) or a full page load (embedded script). */
  page(): PageObject | undefined {
    const candidate = this.headers.get('content-type')?.includes('json')
      ? safeParse(this.body)
      : safeParse(PAGE_SCRIPT.exec(this.body)?.[1]);
    return isPageObject(candidate) ? candidate : undefined;
  }

  /** A cookie set by this response — decrypted, like the app will read it — or undefined. */
  cookie(name: string): string | undefined {
    return this.#setCookie(name)?.value;
  }

  #setCookie(name: string): { value: string; attributes: Map<string, string> } | undefined {
    for (const header of this.headers.getSetCookie()) {
      const cookie = splitSetCookie(header);
      if (cookie.name === name) return { ...cookie, value: this.#cookies.get(name) ?? cookie.value };
    }
    return undefined;
  }

  // --- Status ---------------------------------------------------------------------

  assertStatus(status: number): this {
    if (this.status !== status) this.#fail(`Expected status ${status}, got ${this.status}`);
    return this;
  }
  assertOk(): this {
    return this.assertStatus(200);
  }
  assertSuccessful(): this {
    if (this.status < 200 || this.status > 299) this.#fail(`Expected a 2xx status, got ${this.status}`);
    return this;
  }
  assertCreated(): this {
    return this.assertStatus(201);
  }
  assertNoContent(): this {
    return this.assertStatus(204);
  }
  assertUnauthorized(): this {
    return this.assertStatus(401);
  }
  assertForbidden(): this {
    return this.assertStatus(403);
  }
  assertNotFound(): this {
    return this.assertStatus(404);
  }
  assertUnprocessable(): this {
    return this.assertStatus(422);
  }

  /** A 3xx response, optionally to `location` (path or full URL). */
  assertRedirect(location?: string): this {
    if (this.status < 300 || this.status > 399) this.#fail(`Expected a redirect, got ${this.status}`);
    const actual = this.headers.get('location');
    if (location !== undefined && actual !== location) this.#fail(`Expected a redirect to ${location}, got ${actual}`);
    return this;
  }

  // --- Cookies ----------------------------------------------------------------

  /** The response sets cookie `name` (and it is not an expiry), optionally with `value`. */
  assertCookie(name: string, value?: string): this {
    const cookie = this.#setCookie(name);
    if (!cookie) this.#fail(`Expected cookie "${name}" to be set`);
    if (isExpired(cookie.attributes)) this.#fail(`Expected cookie "${name}" to be set, but it is expired`);
    if (value !== undefined && cookie.value !== value) this.#fail(`Expected cookie "${name}" = "${value}", got "${cookie.value}"`);
    return this;
  }

  /** The response does not touch cookie `name` at all. */
  assertCookieMissing(name: string): this {
    if (this.#setCookie(name)) this.#fail(`Expected no cookie "${name}"`);
    return this;
  }

  /** The response deletes cookie `name` (expires it in the browser). */
  assertCookieExpired(name: string): this {
    const cookie = this.#setCookie(name);
    if (!cookie || !isExpired(cookie.attributes)) this.#fail(`Expected cookie "${name}" to be expired`);
    return this;
  }

  // --- Headers & body ---------------------------------------------------------

  assertHeader(name: string, value?: string): this {
    const actual = this.headers.get(name);
    if (actual === null) this.#fail(`Expected header "${name}"`);
    if (value !== undefined && actual !== value) this.#fail(`Expected header "${name}: ${value}", got "${actual}"`);
    return this;
  }

  /** The JSON body contains `subset` (deeply; other keys may exist). */
  assertJson(subset: unknown): this {
    return this.#compare(() => partialDeepStrictEqual(this.json(), subset), 'JSON does not contain the expected subset');
  }

  assertExactJson(value: unknown): this {
    return this.#compare(() => deepStrictEqual(this.json(), value), 'JSON differs');
  }

  assertSee(text: string): this {
    if (!this.body.includes(text)) this.#fail(`Expected to see "${text}"`);
    return this;
  }

  assertDontSee(text: string): this {
    if (this.body.includes(text)) this.#fail(`Expected not to see "${text}"`);
    return this;
  }

  /**
   * The response renders `component`, optionally with props that contain `props`
   * (deeply) or pass a callback. Typed against the controller when given:
   * `assertPage<ShowUserProfileController>('user-profile/Show', { isOwnProfile: true })`.
   */
  assertPage<TSource extends PageSource = PageSource>(
    component: string,
    props?: DeepPartial<PropsOf<TSource>> | ((props: PropsOf<TSource>) => void),
  ): this {
    const page = this.page();
    if (!page) this.#fail(`Expected a page response (${component})`);
    if (page.component !== component) this.#fail(`Expected page "${component}", got "${page.component}"`);
    if (typeof props === 'function') props(page.props as PropsOf<TSource>);
    else if (props !== undefined) this.#compare(() => partialDeepStrictEqual(page.props, props), `Props of "${component}" do not match`);
    return this;
  }

  // ------------------------------------------------------------------------------

  #compare(check: () => void, message: string): this {
    try {
      check();
    } catch (error) {
      if (!(error instanceof AssertionError)) throw error;
      this.#fail(`${message}\n${error.message}`);
    }
    return this;
  }

  #fail(message: string): never {
    const excerpt = this.body.length > 600 ? `${this.body.slice(0, 600)}…` : this.body;
    throw new AssertionError({ message: `${message}\n  ${this.#label} → ${this.status}\n  ${excerpt}` });
  }
}

function splitSetCookie(header: string): { name: string; value: string; attributes: Map<string, string> } {
  const [pair, ...rest] = header.split(';');
  const index = pair!.indexOf('=');
  const attributes = new Map(
    rest.map((attribute) => {
      const [key, ...value] = attribute.split('=');
      return [key!.trim().toLowerCase(), value.join('=').trim()] as const;
    }),
  );
  return { name: pair!.slice(0, index).trim(), value: decodeURIComponent(pair!.slice(index + 1)), attributes };
}

function isExpired(attributes: ReadonlyMap<string, string>): boolean {
  const maxAge = attributes.get('max-age');
  if (maxAge !== undefined) return Number(maxAge) <= 0;
  const expires = attributes.get('expires');
  return expires !== undefined && Date.parse(expires) <= Date.now();
}

function safeParse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
