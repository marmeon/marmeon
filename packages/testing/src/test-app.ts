import {
  createApplication,
  loadEnv,
  type Application,
  type ApplicationOptions,
  type Container,
  type Key,
  type Resolve,
} from '@bespokecore/core';
import { Encrypter } from '@bespokecore/encryption';
import { CookieEncryption } from '@bespokecore/http';
import { PAGE_HEADER } from '@bespokecore/http/page';
import { createHttpKernel } from '@bespokecore/server';
import type { FactoryDefinition, PendingFactory } from '@bespokecore/database';
import { PendingTestResponse } from './pending.ts';
import { TestResponse } from './response.ts';

export interface TestAppOptions {
  /** Extra environment on top of `.env` and `.env.test`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Replace bindings before the app boots — even singletons see these. */
  override?: (container: Container) => void;
  /**
   * Verify CSRF tokens (default: false). Like Laravel, tests skip CSRF protection
   * unless they test it — then send `_token` or the `X-XSRF-TOKEN` header yourself.
   */
  csrf?: boolean;
}

type FormValue = string | readonly string[];
type MultipartValue = string | Blob | readonly (string | Blob)[];

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Sent as `application/x-www-form-urlencoded`, like an HTML form. Arrays repeat the field. */
  form?: Record<string, FormValue>;
  /** Sent as `multipart/form-data` — for file uploads: `{ avatar: new File([...], 'a.png') }`. */
  multipart?: Record<string, MultipartValue>;
  /** Sent as JSON. */
  json?: unknown;
}

/**
 * Boots a fresh application from its definition — the default export of
 * `bootstrap/app.ts` — and wraps it for HTTP tests.
 *
 * ```ts
 * const app = await createTestApp(application, { override: (c) => c.instance(Mailer, new FakeMailer()) });
 * await app.get('/users/1').assertOk().assertPage('user-profile/Show');
 * ```
 */
export async function createTestApp(definition: ApplicationOptions, options: TestAppOptions = {}): Promise<TestApp> {
  const session = await importSession();
  const application = await createApplication({
    ...definition,
    env: { ...(definition.env ?? loadEnv(definition.root)), ...options.env },
    override: (container) => {
      if (session && options.csrf !== true && container.has(session.CsrfProtection)) container.make(session.CsrfProtection).disable();
      definition.override?.(container);
      options.override?.(container);
    },
  });
  const database = await importDatabase();
  return new TestApp(application, createHttpKernel(application), { headers: {}, cookies: [], session: undefined }, database);
}

interface TestCookie {
  readonly name: string;
  readonly value: string;
  /** Encrypted like the app would (when the app encrypts this cookie at all). */
  readonly encrypt: boolean;
}

interface Defaults {
  readonly headers: Readonly<Record<string, string>>;
  readonly cookies: readonly TestCookie[];
  /** Data for a session created before the request (`withSession`). */
  readonly session: Readonly<Record<string, unknown>> | undefined;
}

/** Access to the app's session store — when the app uses @bespokecore/session (an optional peer). */
export interface SessionAccess {
  readonly cookie: string;
  create(data: Readonly<Record<string, unknown>>): Promise<string>;
  read(id: string): Promise<Record<string, unknown> | undefined>;
}

type DatabaseModule = typeof import('@bespokecore/database');

/** @bespokecore/database is an optional peer, like the session. */
async function importDatabase(): Promise<DatabaseModule | undefined> {
  try {
    return await import('@bespokecore/database');
  } catch {
    return undefined;
  }
}

/** @bespokecore/session is an optional peer: only apps that use it have it installed. */
async function importSession(): Promise<typeof import('@bespokecore/session') | undefined> {
  try {
    return await import('@bespokecore/session');
  } catch {
    return undefined;
  }
}

async function sessionAccess(container: Container): Promise<SessionAccess | undefined> {
  const session = await importSession();
  if (!session || !container.has(session.SessionConfig)) return undefined;
  const config = container.make(session.SessionConfig);
  const store = () => {
    if (config.driver === 'cookie') throw new Error('Session helpers in tests need the memory or file driver (set SESSION_DRIVER=memory in .env.test).');
    return container.make(session.SessionStore);
  };
  return {
    cookie: config.cookie,
    create: async (data) => {
      const id = session.createSessionId();
      const token = crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
      await store().write(id, { _token: token, ...data }, config.lifetime * 60);
      return id;
    },
    read: (id) => store().read(id),
  };
}

/** How the app encrypts cookies — so tests can send and read plain values, like Laravel's. */
export interface CookieCrypto {
  encrypt(name: string, value: string): Promise<string>;
  /** The plain value, or the raw one if it is not encrypted (or not decryptable). */
  decrypt(name: string, value: string): Promise<string>;
}

function cookieCrypto(container: Container): CookieCrypto {
  const encrypted = (name: string) =>
    container.has(Encrypter) && (!container.has(CookieEncryption) || container.make(CookieEncryption).isEncrypted(name));
  return {
    encrypt: async (name, value) => (encrypted(name) ? container.make(Encrypter).encrypt(value, `cookie:${name}`) : value),
    decrypt: async (name, value) => {
      if (!encrypted(name) || value === '') return value;
      try {
        return await container.make(Encrypter).decrypt(value, `cookie:${name}`);
      } catch {
        return value;
      }
    },
  };
}

export class TestApp {
  readonly application: Application;
  readonly #kernel: ReturnType<typeof createHttpKernel>;
  readonly #defaults: Defaults;
  readonly #crypto: CookieCrypto;
  readonly #session: Promise<SessionAccess | undefined>;
  readonly #database: DatabaseModule | undefined;

  constructor(application: Application, kernel: ReturnType<typeof createHttpKernel>, defaults: Defaults, database?: DatabaseModule) {
    this.application = application;
    this.#database = database;
    this.#kernel = kernel;
    this.#defaults = defaults;
    this.#crypto = cookieCrypto(application.container);
    this.#session = sessionAccess(application.container);
  }

  get container(): Container {
    return this.application.container;
  }

  /**
   * Waits for pending `terminate` hooks, then shuts the app down (closes database pools and
   * the like). `await using app = await createTestApp(…)` does this at the end of the block.
   */
  async close(): Promise<void> {
    await this.#kernel.settle();
    await this.application.shutdown();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Rows from a factory, in this app's database (Laravel's `User::factory()`):
   * `await app.factory(UserFactory).count(3).create()`. Needs @bespokecore/database.
   */
  factory<T extends keyof DB & string, DB, S extends string>(definition: FactoryDefinition<T, DB, S>): PendingFactory<T, DB, false, S> {
    if (!this.#database) throw new Error('app.factory() needs @bespokecore/database installed and its provider registered.');
    return this.application.container.make(this.#database.Factories).for(definition);
  }

  /** Resolves a service from the app, e.g. to inspect state after a request. */
  make<K extends Key<any>>(key: K): Resolve<K> {
    return this.application.container.make(key as never) as Resolve<K>;
  }

  // --- Request defaults (each returns a new view of the same app) -------------------

  withHeaders(headers: Record<string, string>): TestApp {
    return this.#with({ headers: { ...this.#defaults.headers, ...headers } });
  }

  /** Sends a cookie, encrypted like the app encrypts its own (Laravel's `withCookie`). */
  withCookie(name: string, value: string): TestApp {
    return this.#with({ cookies: [...this.#defaults.cookies, { name, value, encrypt: true }] });
  }

  /**
   * Starts the request with a session holding `data` (Laravel's `withSession`):
   * `app.withSession({ user_id: '1' }).get('/users/me')`.
   */
  withSession(data: Record<string, unknown>): TestApp {
    return this.#with({ session: { ...this.#defaults.session, ...data } });
  }

  /** Sends a cookie exactly as given — e.g. to prove that forged values are ignored. */
  withUnencryptedCookie(name: string, value: string): TestApp {
    return this.#with({ cookies: [...this.#defaults.cookies, { name, value, encrypt: false }] });
  }

  #with(defaults: Partial<Defaults>): TestApp {
    return new TestApp(this.application, this.#kernel, { ...this.#defaults, ...defaults }, this.#database);
  }

  /** Requests as a client-side navigation: answered with the page object as JSON. */
  navigating(): TestApp {
    return this.withHeaders({ [PAGE_HEADER]: 'true' });
  }

  /** Requests as an API client. */
  expectingJson(): TestApp {
    return this.withHeaders({ accept: 'application/json' });
  }

  // --- Requests -----------------------------------------------------------------

  get(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('GET', path, options);
  }
  post(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('POST', path, options);
  }
  put(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('PUT', path, options);
  }
  patch(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('PATCH', path, options);
  }
  delete(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('DELETE', path, options);
  }

  request(method: string, path: string, options: RequestOptions = {}): PendingTestResponse {
    const label = `${method} ${path}`;
    const response = this.#init(method, options)
      .then((init) => this.#kernel.request(path, init))
      .then(async (res) => {
        const response = await TestResponse.from(res, label, this.#crypto, await this.#session);
        await this.#kernel.settle(); // terminate hooks ran — like Laravel's test helpers call terminate()
        return response;
      });
    return new PendingTestResponse(response);
  }

  async #init(method: string, { headers = {}, form, multipart, json }: RequestOptions): Promise<RequestInit> {
    const testCookies = [...this.#defaults.cookies];
    if (this.#defaults.session) {
      const session = await this.#session;
      if (!session) throw new Error('withSession() needs @bespokecore/session in the app.');
      testCookies.push({ name: session.cookie, value: await session.create(this.#defaults.session), encrypt: true });
    }
    const cookies = await Promise.all(
      testCookies.map(
        async ({ name, value, encrypt }) => `${name}=${encodeURIComponent(encrypt ? await this.#crypto.encrypt(name, value) : value)}`,
      ),
    );
    const cookie = [this.#defaults.headers.cookie, ...cookies].filter(Boolean).join('; ');
    const init: RequestInit = { method, headers: { ...this.#defaults.headers, ...(cookie ? { cookie } : {}), ...headers } };
    if (form) {
      const body = new URLSearchParams();
      for (const [name, value] of Object.entries(form)) for (const item of [value].flat()) body.append(name, item);
      init.body = body;
    }
    if (multipart) {
      const body = new FormData();
      for (const [name, value] of Object.entries(multipart)) for (const item of [value].flat()) body.append(name, item);
      init.body = body;
    }
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    return init;
  }
}
