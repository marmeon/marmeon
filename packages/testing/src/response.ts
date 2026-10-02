import { AssertionError, deepStrictEqual, partialDeepStrictEqual } from 'node:assert';
import {
  ACTION_REDIRECT_HEADER,
  isPageObject,
  LAYER_CLOSE_HEADER,
  PAGE_SCRIPT_ID,
  REGION_HEADER,
  REGION_STATUS_HEADER,
  type CheckViewName,
  type FormOf,
  type IslandOf,
  type IslandProps,
  type LayerClose,
  type PageObject,
  type PageProps,
  type RegionObject,
  type RegionOutcomeStatus,
  type ViewOf,
} from '@bespokecore/http/page';
import type { AuthUser } from '@bespokecore/auth';
import type { SsrOutcome } from './ssr.ts';
import type { CookieCrypto, SessionAccess } from './test-app.ts';

/** `AUTH_SESSION_KEYS.id` of @bespokecore/auth — an optional peer, so not imported at runtime. */
const AUTH_ID = '_auth_id';

/** Something `PageProps` can infer from: a controller class instance or a route closure. */
export type PageSource = { handle: (...args: never[]) => unknown } | ((...args: never[]) => unknown);

/** Field names of a controller's form — typed with a controller (`assertInvalid<C>`), any string without. */
export type FieldOf<C> = unknown extends C ? string : (keyof FormOf<C> & string) | `${keyof FormOf<C> & string}.${string}`;

/** Props of a page, every level optional — for asserting a subset. */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * The page a controller renders when one is given (`assertPage<ShowUserController>('user-profile/Show')`) — any of the
 * app's views otherwise (`V`, inferred from the argument, so a typo is named as such).
 */
export type PageNameOf<TSource extends PageSource, V extends string = string> = PageSource extends TSource ? CheckViewName<V> : ViewOf<TSource>;

/** Typed props when a controller is given (`assertPage<ShowUserController>`), any record otherwise. */
export type PropsOf<TSource extends PageSource> = PageSource extends TSource ? Record<string, unknown> : PageProps<TSource>;

type IslandSource = { handle: (...args: never[]) => unknown };

/** The island a controller renders when one is given (`assertIsland<ShowRecentSignInsController>('dashboard/RecentSignIns')`). */
export type IslandNameOf<TSource extends IslandSource, V extends string = string> = IslandSource extends TSource ? CheckViewName<V> : IslandOf<TSource>;

/** Typed island props when a controller is given, any record otherwise. */
export type IslandPropsOf<TSource extends IslandSource> = IslandSource extends TSource ? Record<string, unknown> : IslandProps<TSource>;

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
  /** The session as the request left it — undefined if the app has no session. */
  readonly #session: Record<string, unknown> | undefined;
  /** What server rendering did — undefined without `createTestApp(…, { ssr: true })`. */
  readonly #ssr: SsrOutcome | undefined;

  constructor(
    response: Response,
    body: string,
    label: string,
    cookies: ReadonlyMap<string, string> = new Map(),
    session?: Record<string, unknown>,
    ssr?: SsrOutcome,
  ) {
    this.status = response.status;
    this.headers = response.headers;
    this.body = body;
    this.#label = label;
    this.#cookies = cookies;
    this.#session = session;
    this.#ssr = ssr;
  }

  static async from(
    response: Response,
    label: string,
    crypto?: CookieCrypto,
    sessions?: SessionAccess,
    ssr?: (page: PageObject | undefined) => Promise<SsrOutcome | undefined>,
  ): Promise<TestResponse> {
    const cookies = new Map<string, string>();
    for (const header of response.headers.getSetCookie()) {
      const { name, value } = splitSetCookie(header);
      cookies.set(name, crypto ? await crypto.decrypt(name, value) : value);
    }
    const id = sessions ? cookies.get(sessions.cookie) : undefined;
    const session = id ? await sessions!.read(id) : undefined;
    const body = await response.text();
    const page = response.headers.get('content-type')?.includes('text/html') ? pageIn(body) : undefined;
    return new TestResponse(response, body, label, cookies, session, await ssr?.(page));
  }

  /** The session data after the request (from the store, via the session cookie). */
  session(): Record<string, unknown> {
    if (!this.#session) this.#fail('Expected the response to carry a session (is StartSession on this route?)');
    return this.#session;
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
    if (!this.headers.get('content-type')?.includes('json')) return pageIn(this.body);
    const candidate = safeParse(this.body);
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

  // --- Session ----------------------------------------------------------------

  /** The session holds `key` after the request, optionally with `value` (compared deeply). */
  assertSessionHas(key: string, value?: unknown): this {
    const session = this.session();
    if (session[key] === undefined) this.#fail(`Expected the session to have "${key}"`);
    if (value !== undefined) {
      this.#compare(() => deepStrictEqual(session[key], value), `Session value "${key}" differs`);
    }
    return this;
  }

  assertSessionMissing(key: string): this {
    if (this.session()[key] !== undefined) this.#fail(`Expected the session not to have "${key}"`);
    return this;
  }

  // --- Authentication (@bespokecore/auth) -------------------------------------------

  /** The session is signed in after the request — as `user`, when given (compared by id). */
  assertAuthenticated(user?: AuthUser): this {
    const id = this.session()[AUTH_ID];
    if (id === undefined) this.#fail('Expected the session to be signed in, but it is a guest');
    if (user !== undefined) this.#compare(() => deepStrictEqual(id, (user as unknown as { id: unknown }).id), 'Signed in as another user');
    return this;
  }

  /** The session is not signed in after the request. */
  assertGuest(): this {
    const id = this.session()[AUTH_ID];
    if (id !== undefined) this.#fail(`Expected a guest, but the session is signed in as user ${JSON.stringify(id)}`);
    return this;
  }

  // --- Validation ---------------------------------------------------------------

  /**
   * The request failed validation for `fields` — from a 422 JSON answer, or from the
   * errors a page request flashed to the session. Messages match exactly or by RegExp:
   * `assertInvalid<UpdateUserProfileController>({ name: /short/ })`.
   */
  assertInvalid<C = unknown>(fields: readonly FieldOf<C>[] | Partial<Record<FieldOf<C>, string | RegExp>>): this {
    const errors = this.#validationErrors();
    if (!errors) this.#fail('Expected validation errors, found none');
    const expected: [string, string | RegExp | undefined][] = Array.isArray(fields)
      ? fields.map((field: string) => [field, undefined])
      : Object.entries(fields as Record<string, string | RegExp>);
    for (const [field, message] of expected) {
      const messages = errors[field];
      if (!messages?.length) this.#fail(`Expected a validation error for "${field}", got errors for: ${Object.keys(errors).join(', ')}`);
      if (message !== undefined && !messages.some((text) => (typeof message === 'string' ? text === message : message.test(text)))) {
        this.#fail(`Expected "${field}" to fail with ${String(message)}, got: ${messages.join(' | ')}`);
      }
    }
    return this;
  }

  /** The request passed validation: no 422, no flashed errors. */
  assertValid(): this {
    const errors = this.#validationErrors();
    if (errors) this.#fail(`Expected no validation errors, got: ${JSON.stringify(errors)}`);
    return this;
  }

  #validationErrors(): Record<string, string[]> | undefined {
    if (this.status === 422) return (safeParse(this.body) as { errors?: Record<string, string[]> } | undefined)?.errors;
    const flashed = this.#session?.errors as Record<string, string[]> | undefined;
    return flashed && Object.keys(flashed).length > 0 ? flashed : undefined;
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
  assertPage<TSource extends PageSource = PageSource, const V extends string = string>(
    component: PageNameOf<TSource, V>,
    props?: DeepPartial<PropsOf<TSource>> | ((props: PropsOf<TSource>) => void),
  ): this {
    const page = this.page();
    if (!page) this.#fail(`Expected a page response (${component})`);
    if (page.component !== component) this.#fail(`Expected page "${component}", got "${page.component}"`);
    if (typeof props === 'function') props(page.props as PropsOf<TSource>);
    else if (props !== undefined) this.#compare(() => partialDeepStrictEqual(page.props, props), `Props of "${component}" do not match`);
    return this;
  }

  /** The region object of an island's response (`app.island(…)`), or undefined. */
  island(): RegionObject | undefined {
    if (this.headers.get(REGION_HEADER) !== 'island') return undefined;
    const candidate = safeParse(this.body);
    return isPageObject(candidate) ? candidate : undefined;
  }

  /**
   * The response is island `component`'s region object, optionally with props that contain `props` (deeply) or pass a
   * callback — typed against the controller when given: `assertIsland<ShowRecentSignInsController>('dashboard/RecentSignIns')`.
   */
  assertIsland<TSource extends IslandSource = IslandSource, const V extends string = string>(
    component: IslandNameOf<TSource, V>,
    props?: DeepPartial<IslandPropsOf<TSource>> | ((props: IslandPropsOf<TSource>) => void),
  ): this {
    const region = this.island();
    if (!region) {
      const outcome = this.headers.get(REGION_STATUS_HEADER);
      this.#fail(`Expected the island ${component}, got ${outcome ? `its outcome "${outcome}"` : 'no island'} (status ${this.status})`);
    }
    if (region.component !== component) this.#fail(`Expected island "${component}", got "${region.component}"`);
    if (typeof props === 'function') props(region.props as IslandPropsOf<TSource>);
    else if (props !== undefined) this.#compare(() => partialDeepStrictEqual(region.props, props), `Props of island "${component}" do not match`);
    return this;
  }

  /** The island's request ended without its region: `unauthorized` (a redirect, 401), `forbidden` (403) or `exception`. */
  assertIslandStatus(status: RegionOutcomeStatus): this {
    const outcome = this.headers.get(REGION_STATUS_HEADER);
    if (outcome !== status) this.#fail(`Expected the island's outcome "${status}", got ${outcome ? `"${outcome}"` : 'none'} (status ${this.status})`);
    return this;
  }

  // --- Actions (E59) -----------------------------------------------------------------

  /** The answer of an action (`acting()`) that redirected: `204` with `x-bespoke-redirect` — to `url`, when given. */
  assertActionRedirect(url?: string): this {
    const target = this.headers.get(ACTION_REDIRECT_HEADER);
    if (this.status !== 204 || target === null) this.#fail(`Expected the action to redirect (204 with ${ACTION_REDIRECT_HEADER}), got status ${this.status}`);
    if (url !== undefined && target !== url) this.#fail(`Expected the action to redirect to ${url}, got ${target}`);
    return this;
  }

  // --- Layers (E53) ------------------------------------------------------------------

  /**
   * The response is layer `component`'s page object (a client-side request — `app.layering()` — answered by
   * `this.view(…).layer(…)`), optionally with props that contain `props` or pass a callback — typed against the controller
   * when given: `assertLayer<EditUserProfileController>('user-profile/Edit', { profile: { id: ada.id } })`.
   */
  assertLayer<TSource extends PageSource = PageSource, const V extends string = string>(
    component: PageNameOf<TSource, V>,
    props?: DeepPartial<PropsOf<TSource>> | ((props: PropsOf<TSource>) => void),
  ): this {
    const page = this.page();
    if (!page?.layer) this.#fail(`Expected the layer ${component}, got ${page ? `the page "${page.component}"` : `no page (status ${this.status})`}`);
    return this.assertPage<TSource, V>(component, props);
  }

  /** The layers a document stacks over its page (a deep link of a layer's URL), bottom first — empty for any other page. */
  layers(): PageObject[] {
    return this.page()?.layers ?? [];
  }

  /**
   * The response tells the layer's client to close (`closeLayer()`, E53): `layers` of them (default 1) and, when given, to
   * reload `reload` beneath them.
   */
  assertLayerClosed(expected: Partial<LayerClose> = {}): this {
    if (this.headers.get(LAYER_CLOSE_HEADER) !== 'true') this.#fail(`Expected the layer to close, got status ${this.status}${this.headers.get('location') ? ` → ${this.headers.get('location')}` : ''}`);
    const { close } = this.json<{ close: LayerClose }>();
    const want = { layers: expected.layers ?? 1, ...(expected.reload === undefined ? {} : { reload: expected.reload }) };
    this.#compare(() => partialDeepStrictEqual(close, want), 'The layer closes otherwise');
    return this;
  }

  // --- Server rendering (createTestApp(…, { ssr: true })) -------------------------

  /** The page was rendered on the server — without an error, in the shell or after it (the error is shown). */
  assertServerRendered(): this {
    const ssr = this.#requireSsr('assertServerRendered');
    const [error] = ssr.errors;
    if (error !== undefined) this.#fail(`Expected the page to render on the server, but it failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (!this.page()) this.#fail('Expected a server-rendered page, got no page document');
    return this;
  }

  /**
   * The markup is what the browser renders from the page object it receives — the page hydrates without a mismatch.
   * Compares the document with one rendered again from the page's JSON (what the browser reads), so a prop the server
   * rendered differently than it sent (a `Date` instead of its string) fails here.
   */
  assertHydrates(): this {
    this.#requireSsr('assertHydrates');
    this.assertServerRendered();
    const { rerendered } = this.#ssr!;
    if (rerendered === undefined) this.#fail('Could not render the page again from its JSON');
    if (rerendered !== this.body) {
      let at = 0;
      while (at < this.body.length && this.body[at] === rerendered[at]) at++;
      const around = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 80), at + 80));
      this.#fail(
        `Expected the page to hydrate: the server rendered other markup than the browser will from the page object.\n` +
          `  server:  ${around(this.body)}\n  browser: ${around(rerendered)}`,
      );
    }
    return this;
  }

  #requireSsr(assertion: string): SsrOutcome {
    if (!this.#ssr) this.#fail(`${assertion}() needs server rendering in the test: createTestApp(app, { ssr: true })`);
    return this.#ssr;
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

/** The page object embedded in a page document. */
function pageIn(html: string): PageObject | undefined {
  const candidate = safeParse(PAGE_SCRIPT.exec(html)?.[1]);
  return isPageObject(candidate) ? candidate : undefined;
}

function safeParse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
