import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventDispatcher, EventRegistry, Translator, type Application, type Container, type Key } from '@bespokecore/core';
import { Router } from '@bespokecore/router';

/** A helper of the session — what `.ls` lists. */
export interface Helper {
  readonly name: string;
  /** How it is used, for `.ls`. */
  readonly usage: string;
  readonly description: string;
  /** Whether the app has what it needs (false: `.ls` names the package, using it says what to install). */
  readonly available: boolean;
  /** Builds the value — on first use. */
  readonly value: () => unknown;
}

/** What `--sandbox` needs of `Connections` (@bespokecore/database) — found by name, so the CLI does not depend on the package. */
interface SandboxConnections {
  transaction<R>(callback: () => Promise<R>): Promise<R>;
  options(name?: string): { readonly driver: 'sqlite'; readonly database: string } | { readonly driver: 'pgsql'; readonly url: string };
}

type RepositoryClass = (new (...args: any[]) => object) & { readonly table: string };

/** Directories never searched for repositories. */
const NOT_APP_CODE = /(^|[\\/])(node_modules|dist|storage|\.bespoke|\.git|public)([\\/]|$)/;

/** The rollback at the end of a sandbox session — thrown out of the transaction's callback, caught by the session. */
const ROLLBACK = Symbol('tinker sandbox rollback');

/**
 * One `bespoke tinker` session (E122): the booted app, ONE container scope for all of it (like a command's — scoped
 * services such as the Translator in `APP_LOCALE` live as long as the session), the helpers, and — with `--sandbox` —
 * a transaction around everything that rolls back at the end.
 *
 * Nothing of it is global: the helpers are properties of the REPL's context ({@link attach}), built on first use and
 * removed again when the session ends ({@link detach}); the framework's modules never see them.
 *
 * The helpers of packages the CLI does not depend on (`db`, `jobs`, `mail`, `repos`, the sandbox) are found by the name
 * the package binds them under — `Database`, `Queue`, `Mailer`, `Connections` — so an app without the package still has
 * a tinker, whose `.ls` says what is missing.
 */
export class TinkerSession {
  readonly app: Application;
  readonly scope: Container;
  readonly sandbox: boolean;
  /** Classes and tokens the app knows, by name: bound in the container, listed by a module (jobs, listeners, …), repositories. */
  readonly #names = new Map<string, Key>();
  /** Repositories by their name in `repos` — once loaded. */
  #repositories: Map<string, RepositoryClass> | undefined;
  #loading: Promise<Map<string, RepositoryClass>> | undefined;
  readonly #values = new Map<string, unknown>();
  /** The REPL context while attached, and what was there before. */
  #context: Record<string, unknown> | undefined;
  readonly #previous = new Map<string, PropertyDescriptor | undefined>();
  /** The sandbox: runs a function inside its transaction; ends it; settles when it rolled back. */
  #inside: (<R>(fn: () => R) => R) | undefined;
  #end: (() => void) | undefined;
  #done: Promise<void> | undefined;

  constructor(app: Application, options: { readonly sandbox?: boolean } = {}) {
    this.app = app;
    this.scope = app.container.createScope();
    this.sandbox = options.sandbox === true;
    this.#collectNames();
  }

  // -- The helpers -------------------------------------------------------------------------------------------------

  helpers(): Helper[] {
    const byName = (name: string, label: string, pkg: string) => {
      const key = this.#names.get(name);
      return {
        available: key !== undefined,
        value: () => {
          if (!key) throw new Error(`${label} needs ${pkg} (pnpm add ${pkg}; bespoke discover).`);
          return this.scope.make(key as Key<unknown>);
        },
      };
    };
    const translator = this.scope.has(Translator);
    return [
      { name: 'app', usage: 'app', description: 'the Application — container, modules, root', available: true, value: () => this.app },
      {
        name: 'make',
        usage: "make(Key) · make('Name')",
        description: 'resolves a class or token in the session scope (Tab completes names)',
        available: true,
        value: () => (key: Key | string) => this.make(key),
      },
      { name: 'db', usage: 'db', description: 'Kysely on the default connection', ...byName('Database', 'db', '@bespokecore/database') },
      {
        name: 'repos',
        usage: 'repos.<table>',
        description: 'the repositories (*Repository.ts), by table: repos.users',
        available: this.#names.has('Connections'),
        value: () => {
          if (!this.#names.has('Connections')) throw new Error('repos needs @bespokecore/database (pnpm add @bespokecore/database; bespoke discover).');
          return this.#repositoryObject();
        },
      },
      { name: 'jobs', usage: 'jobs.dispatch(Job, payload)', description: 'the Queue', ...byName('Queue', 'jobs', '@bespokecore/queue') },
      { name: 'events', usage: 'events.dispatch(new Event(…))', description: 'the EventDispatcher', available: true, value: () => this.scope.make(EventDispatcher) },
      { name: 'mail', usage: 'mail.send(new Mail(…))', description: 'the Mailer', ...byName('Mailer', 'mail', '@bespokecore/mail') },
      {
        name: 'url',
        usage: "url('route.name', params?, query?)",
        description: 'the path of a named route',
        available: this.scope.has(Router),
        value: () => {
          const router = this.scope.make(Router);
          return (name: string, params?: Record<string, string | number>, query?: Record<string, unknown>) => (router.url as (...args: unknown[]) => string)(name, params, query);
        },
      },
      {
        name: 't',
        usage: "t('key', params?)",
        description: 'a text in APP_LOCALE',
        available: translator,
        value: () => {
          if (!translator) throw new Error('t needs @bespokecore/i18n (pnpm add @bespokecore/i18n; bespoke discover).');
          const translations = this.scope.make(Translator);
          return (key: string, params?: Record<string, unknown>) => translations.text(key, params);
        },
      },
      { name: 'config', usage: 'config.<name>', description: 'the resolved configuration, by name: config.app', available: true, value: () => this.#configObject() },
    ];
  }

  /** `make(Key)` or `make('Name')` — in the session scope. */
  make(key: Key | string): unknown {
    if (typeof key !== 'string') return this.scope.make(key as Key<unknown>);
    const found = this.#names.get(key);
    if (!found) throw new Error(`No class or token is known by the name "${key}".${didYouMean(key, [...this.#names.keys()])}`);
    return this.scope.make(found as Key<unknown>);
  }

  /** Every class and token name the session knows (repositories once loaded) — for `make(` and the context. */
  names(): string[] {
    return [...this.#names.keys()].sort();
  }

  routeNames(): string[] {
    if (!this.scope.has(Router)) return [];
    return this.scope
      .make(Router)
      .routes.flatMap((route) => (route.routeName ? [route.routeName] : []))
      .sort();
  }

  configNames(): string[] {
    return [...this.#configDefinitions().keys()].sort();
  }

  /** The names in `repos` — loads the repositories on first use. */
  async repositoryNames(): Promise<string[]> {
    return [...(await this.loadRepositories()).keys()].sort();
  }

  /**
   * Finds the app's repositories: every `*Repository.ts` under the app root (not in `node_modules`, `dist`, `storage`),
   * imported once; each exported class with `static table` is one. They are named by their table (`repos.users`), or —
   * where two share a table — by their class name. Their class names join the names `make` and the context know.
   */
  loadRepositories(): Promise<Map<string, RepositoryClass>> {
    this.#loading ??= this.#findRepositories().then(
      (found) => {
        this.#repositories = found;
        for (const Repository of found.values()) this.#addName(Repository.name, Repository);
        if (this.#context) for (const Repository of found.values()) this.#defineName(Repository.name, Repository);
        return found;
      },
      (error: unknown) => {
        this.#loading = undefined;
        throw error;
      },
    );
    return this.#loading;
  }

  // -- The REPL context --------------------------------------------------------------------------------------------

  /**
   * Puts the helpers and the known names onto the REPL's context — lazily: a helper is built on first use, and an
   * assignment (`db = …`) replaces it like any variable. A name the context already has (`URL`, `Response`) stays.
   */
  attach(context: Record<string, unknown>): void {
    this.#context = context;
    for (const helper of this.helpers()) {
      this.#define(helper.name, {
        get: () => {
          if (!this.#values.has(helper.name)) this.#values.set(helper.name, helper.value());
          return this.#values.get(helper.name);
        },
      });
    }
    for (const [name, key] of this.#names) this.#defineName(name, key);
  }

  /** Takes everything {@link attach} put on the context away again — what was there before comes back. */
  detach(): void {
    const context = this.#context;
    if (!context) return;
    for (const [name, previous] of this.#previous) {
      if (previous) Object.defineProperty(context, name, previous);
      else delete context[name];
    }
    this.#previous.clear();
    this.#context = undefined;
  }

  // -- Evaluation and the sandbox ----------------------------------------------------------------------------------

  /**
   * Runs one input (`run` evaluates the JavaScript). Repositories are loaded first when it names them. In the sandbox it
   * runs inside the session's transaction — as a savepoint of its own: an input that fails takes back only its own
   * writes, and on Postgres the transaction stays usable after a failed statement. As in every `transaction()` (E107),
   * await database work in the input that starts it.
   */
  async evaluate<R>(code: string, run: () => Promise<R>): Promise<R> {
    if (/\brepos\b|Repository\b/.test(code)) await this.loadRepositories();
    const inside = this.#inside;
    if (!inside) return run();
    const connections = this.#connections()!;
    return inside(() => connections.transaction(() => run()));
  }

  /** Opens the sandbox's transaction on the default connection (with `--sandbox`; otherwise nothing to do). */
  async open(): Promise<void> {
    if (!this.sandbox || this.#done) return;
    const connections = this.#connections();
    if (!connections) throw new Error('--sandbox needs @bespokecore/database (pnpm add @bespokecore/database; bespoke discover).');
    const inside = Promise.withResolvers<<R>(fn: () => R) => R>();
    const end = Promise.withResolvers<void>();
    this.#end = end.resolve;
    // The transaction lasts as long as its callback: it captures the context (the transaction of this call chain) for the
    // inputs to come, then waits for the end of the session and throws — the rollback.
    this.#done = connections
      .transaction(async () => {
        inside.resolve(AsyncLocalStorage.snapshot());
        await end.promise;
        throw ROLLBACK;
      })
      .then(
        () => undefined,
        (error: unknown) => {
          if (error === ROLLBACK) return;
          if (error instanceof SuppressedError && error.suppressed === ROLLBACK) throw error.error;
          throw error;
        },
      );
    this.#inside = await Promise.race([
      inside.promise,
      this.#done.then(() => {
        throw new Error('The sandbox transaction ended before the session began.');
      }),
    ]);
  }

  /** Ends the session — in the sandbox, its transaction rolls back: everything the session wrote is gone. Runs once. */
  close(): Promise<void> {
    this.#inside = undefined;
    this.#end?.();
    return this.#done ?? Promise.resolve();
  }

  /** What the banner says about the default connection — the driver and where, never credentials. */
  database(): string | undefined {
    const connections = this.#connections();
    if (!connections) return undefined;
    const options = connections.options('default');
    if (options.driver === 'sqlite') return `sqlite (${options.database})`;
    const url = new URL(options.url);
    return `pgsql (${url.host}${url.pathname})`;
  }

  /** The app's name, for the banner: its package.json `name`, or its directory. */
  appName(): string {
    try {
      const { name } = JSON.parse(readFileSync(join(this.app.root, 'package.json'), 'utf8')) as { name?: unknown };
      if (typeof name === 'string' && name) return name;
    } catch {
      // No package.json — the directory names it.
    }
    return basename(this.app.root);
  }

  // -- Internals ---------------------------------------------------------------------------------------------------

  #connections(): SandboxConnections | undefined {
    const key = this.#names.get('Connections');
    return key ? (this.scope.make(key as Key<SandboxConnections>) as SandboxConnections) : undefined;
  }

  /** The names: what the container binds, what the modules list (jobs, notifications, seeders, listeners and their events, …). */
  #collectNames(): void {
    for (const key of this.app.container.keys()) this.#addName(key.name, key);
    const fromList = (value: unknown) => {
      if (typeof value === 'function') this.#addName(value.name, value as Key);
      else if (value && typeof value === 'object') {
        for (const part of ['event', 'listener'] as const) {
          const item = (value as Record<string, unknown>)[part];
          if (typeof item === 'function') this.#addName(item.name, item as Key);
        }
      }
    };
    for (const module of this.app.modules) {
      for (const value of Object.values(module)) if (Array.isArray(value)) value.forEach(fromList);
    }
    if (this.app.container.has(EventRegistry)) this.app.container.make(EventRegistry).all().forEach(fromList);
  }

  #addName(name: string, key: Key): void {
    if (/^[A-Z][\w$]*$/.test(name) && !this.#names.has(name)) this.#names.set(name, key);
  }

  #defineName(name: string, key: Key): void {
    // A class or token by its name — unless the context has something of that name already (a global like `URL`).
    if (!this.#context || name in this.#context) return;
    this.#define(name, { value: key, writable: true });
  }

  #define(name: string, descriptor: PropertyDescriptor): void {
    const context = this.#context!;
    if (!this.#previous.has(name)) this.#previous.set(name, Object.getOwnPropertyDescriptor(context, name));
    const replaceable = 'get' in descriptor ? { set: (value: unknown) => Object.defineProperty(context, name, { value, writable: true, configurable: true, enumerable: true }) } : {};
    Object.defineProperty(context, name, { configurable: true, enumerable: true, ...descriptor, ...replaceable });
  }

  #repositoryObject(): Record<string, unknown> {
    const repos: Record<string, unknown> = {};
    for (const [name, Repository] of this.#repositories ?? []) {
      let instance: unknown;
      Object.defineProperty(repos, name, { enumerable: true, get: () => (instance ??= this.scope.make(Repository as unknown as Key<object>)) });
    }
    return repos;
  }

  #configDefinitions(): Map<string, Key> {
    const definitions = new Map<string, Key>();
    for (const key of this.app.container.keys()) {
      if (typeof key === 'object' && 'resolve' in key && 'env' in key) definitions.set(key.name, key);
    }
    return definitions;
  }

  #configObject(): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const [name, definition] of this.#configDefinitions()) {
      Object.defineProperty(config, name, { enumerable: true, get: () => this.scope.make(definition as Key<unknown>) });
    }
    return config;
  }

  async #findRepositories(): Promise<Map<string, RepositoryClass>> {
    const classes: RepositoryClass[] = [];
    for await (const file of glob('**/*Repository.ts', { cwd: this.app.root, exclude: (path) => NOT_APP_CODE.test(String(path)) })) {
      const module = (await import(pathToFileURL(join(this.app.root, file)).href)) as Record<string, unknown>;
      for (const value of Object.values(module)) if (isRepositoryClass(value) && !classes.includes(value)) classes.push(value);
    }
    classes.sort((a, b) => a.name.localeCompare(b.name));
    const byTable = Map.groupBy(classes, (Repository) => Repository.table);
    const named = new Map<string, RepositoryClass>();
    for (const [table, shared] of byTable) {
      if (shared.length === 1) named.set(table, shared[0]!);
      else for (const Repository of shared) named.set(Repository.name, Repository);
    }
    return named;
  }
}

/** A repository class (@bespokecore/database): `static table` and the repository methods — told apart without importing the package. */
function isRepositoryClass(value: unknown): value is RepositoryClass {
  if (typeof value !== 'function' || typeof (value as { table?: unknown }).table !== 'string') return false;
  const prototype = (value as { prototype?: Record<string, unknown> }).prototype;
  return typeof prototype?.query === 'function' && typeof prototype.find === 'function';
}

function didYouMean(name: string, names: readonly string[]): string {
  const lower = name.toLowerCase();
  const close = names.filter((candidate) => candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase())).slice(0, 3);
  return close.length ? ` Did you mean ${close.map((candidate) => `"${candidate}"`).join(', ')}?` : '';
}
