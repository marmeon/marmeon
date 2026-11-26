import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, realpathSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventDispatcher, EventRegistry, Translator, type Application, type Container, type Key } from '@marmeon/core';
import { belongsTo, findPackage, importPackage, isInside, resolveExports, runtimeConditions, withCode } from '@marmeon/core/internal';
import { Router } from '@marmeon/router';
import { appListedProviders, providerJobsOf } from '../app-providers.ts';
import { secondCopies, UnreadableTree } from '../check/packages.ts';

/** A helper of the session — what `.ls` lists. */
export interface Helper {
  readonly name: string;
  /** How it is used, for `.ls`. */
  readonly usage: string;
  readonly description: string;
  /** Whether the app has what it needs (false: `.ls` says why, using it says what to do). */
  readonly available: boolean;
  /** Why it is not available, where a package of the app's is behind it: not installed or not listed, installed but not loadable, loaded but not registered. */
  readonly problem?: 'missing' | 'unloadable' | 'unregistered';
  /** Builds the value — on first use. */
  readonly value: () => unknown;
}

/** What `--sandbox` needs of `Connections` (@marmeon/database) — the class of the app's own copy of the package (found by {@link ownExport}), so the CLI does not depend on it. */
interface SandboxConnections {
  transaction<R>(callback: () => Promise<R>): Promise<R>;
  options(name?: string): { readonly driver: 'sqlite'; readonly database: string } | { readonly driver: 'pgsql' | 'mysql'; readonly url: string };
}

type RepositoryClass = (new (...args: any[]) => object) & { readonly table: string };

/**
 * A class or token of the app's own copy of a package — or why there is none: `missing` (the app does not list the package, or it is not
 * installed) or `unloadable` (installed, but its entry leads out of it, does not load or lacks the export).
 */
type Own = Key | 'missing' | 'unloadable';

/** The classes and tokens of the app's own packages the helpers and the sandbox resolve — by identity, never by a name. */
interface OwnExports {
  readonly Connections: Own;
  readonly Database: Own;
  readonly Queue: Own;
  readonly Mailer: Own;
}

/** The names the app's `package.json` lists, as discovery reads its root: dependencies, optional and peer dependencies, dev dependencies. */
function listedDependencies(root: string): Set<string> {
  const listed = new Set<string>();
  try {
    const json: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (typeof json !== 'object' || json === null) return listed;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      const list = Object.hasOwn(json, field) ? (json as Record<string, unknown>)[field] : undefined;
      if (typeof list === 'object' && list !== null) for (const name of Object.keys(list)) listed.add(name);
    }
  } catch {
    // No readable package.json: the app lists nothing.
  }
  return listed;
}

/**
 * One export of a package the app's `package.json` lists, found the way discovery finds the copy it binds for the app (`findPackage` from the
 * app root, which walks `node_modules` directories only — never `NODE_PATH` — and the entry through `exports` under the process's
 * conditions), and only a copy the app lists, never one that only another package depends on. The entry must lie in the package, by its path
 * and by its real path (no `node_modules` of the package below it either), so a package cannot make tinker run another one's code. A class (`Connections`) or a token (`Database`, `Queue`,
 * `Mailer`) of that copy; a class or token of the same name anywhere else is no stand-in. See {@link Own} for the two ways there is none.
 */
async function ownExport(root: string, listed: ReadonlySet<string>, pkg: string, name: string): Promise<Own> {
  if (!listed.has(pkg)) return 'missing';
  try {
    const found = findPackage(pkg, root);
    if (!found) return 'missing';
    const entry = resolveExports(found, '.', runtimeConditions());
    if (!entry || !belongsTo(resolve(found.dir), resolve(entry))) return 'unloadable';
    const real = realpathSync.native(entry);
    if (!isInside(found.dir, real) || !belongsTo(found.dir, real)) return 'unloadable';
    // The URL discovery imports, so a package linked from outside `node_modules` in a test runner is the instance discovery loaded.
    const value = (await importPackage(pathToFileURL(entry).href, (file) => import(file)))[name];
    return typeof value === 'function' || (typeof value === 'object' && value !== null) ? (value as Key) : 'unloadable';
  } catch {
    return 'unloadable';
  }
}

/** Directories never searched for repositories. */
const NOT_APP_CODE = /(^|[\\/])(node_modules|dist|storage|\.marmeon|\.git|public)([\\/]|$)/;

/** The rollback at the end of a sandbox session — thrown out of the transaction's callback, caught by the session. */
const ROLLBACK = Symbol('tinker sandbox rollback');

/**
 * One `marmeon tinker` session: the booted app, one container scope for all of it, the helpers and — with `--sandbox` — a
 * transaction around everything that rolls back at the end. The helpers live on the REPL's context only, built on first use;
 * those of packages the CLI does not depend on are the classes and tokens (`Database`, `Queue`, `Mailer`, `Connections`) of the
 * copy of the package that your app's `package.json` lists, resolved by {@link open} (call it first), so an app without the package still has a tinker. See docs/console.md#tinker.
 */
export class TinkerSession {
  readonly app: Application;
  readonly scope: Container;
  readonly sandbox: boolean;
  /** Classes and tokens the app knows, by name: bound in the container, listed by a module (jobs, listeners, …), repositories. */
  readonly #names = new Map<string, Key>();
  /**
   * The jobs the providers list in `static [providerJobs]`, by class name — the last resort, read only where a name is made or shown
   * (`make('Name')`, the suggestions, `names()` and the context). Never a helper's, a repository's or the sandbox's name,
   * and never in the way of another name: a name in {@link #names} wins, also one that arrives later. A repository takes its
   * name back once the repositories are loaded; an input that writes the name out loads them.
   */
  readonly #fallback = new Map<string, Key>();
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
  /** The classes and tokens of the app's own packages — undefined until {@link open} resolved them. */
  #resolved: OwnExports | undefined;

  constructor(app: Application, options: { readonly sandbox?: boolean } = {}) {
    this.app = app;
    this.scope = app.container.createScope();
    this.sandbox = options.sandbox === true;
    this.#collectNames();
  }

  // -- The helpers -------------------------------------------------------------------------------------------------

  helpers(): Helper[] {
    const own = this.#own();
    const helper = (key: Own, label: string, pkg: string, name: string) => {
      const problem = this.#problem(key, label, pkg, name);
      return {
        available: problem === undefined,
        ...(problem && { problem: problem.kind }),
        value: () => {
          if (problem !== undefined) throw new Error(problem.message);
          return this.scope.make(key as Key<unknown>);
        },
      };
    };
    const repos = this.#problem(own.Connections, 'repos', '@marmeon/database', 'Connections');
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
      { name: 'db', usage: 'db', description: 'Kysely on the default connection', ...helper(own.Database, 'db', '@marmeon/database', 'Database') },
      {
        name: 'repos',
        usage: 'repos.<table>',
        description: 'the repositories (*Repository.ts), by table: repos.users',
        available: repos === undefined,
        ...(repos && { problem: repos.kind }),
        value: () => {
          if (repos !== undefined) throw new Error(repos.message);
          return this.#repositoryObject();
        },
      },
      { name: 'jobs', usage: 'jobs.dispatch(Job, payload)', description: 'the Queue', ...helper(own.Queue, 'jobs', '@marmeon/queue', 'Queue') },
      { name: 'events', usage: 'events.dispatch(new Event(…))', description: 'the EventDispatcher', available: true, value: () => this.scope.make(EventDispatcher) },
      { name: 'mail', usage: 'mail.send(new Mail(…))', description: 'the Mailer', ...helper(own.Mailer, 'mail', '@marmeon/mail', 'Mailer') },
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
          if (!translator) throw new Error('t needs @marmeon/i18n (marmeon add i18n; if it is installed already: marmeon discover).');
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
    const found = this.#names.get(key) ?? this.#fallback.get(key);
    if (!found) throw new Error(`No class or token is known by the name "${key}".${didYouMean(key, this.names())}`);
    return this.scope.make(found as Key<unknown>);
  }

  /** Every class and token name the session knows (repositories once loaded) — for `make(` and the context. */
  names(): string[] {
    return [...new Set([...this.#names.keys(), ...this.#fallback.keys()])].sort();
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
    // Resolved at use, so a repository loaded later takes the bare name too.
    for (const name of this.#fallback.keys()) {
      if (this.#names.has(name) || name in context) continue;
      this.#define(name, { get: () => this.#names.get(name) ?? this.#fallback.get(name) });
    }
  }

  /** Takes everything {@link attach} put on the context away again — what was there before comes back. */
  detach(): void {
    const context = this.#context;
    if (!context) return;
    for (const [name, previous] of this.#previous) {
      if (previous) Object.defineProperty(context, name, previous);
      else Reflect.deleteProperty(context, name);
    }
    this.#previous.clear();
    this.#context = undefined;
  }

  // -- Evaluation and the sandbox ----------------------------------------------------------------------------------

  /**
   * Runs one input (`run` evaluates the JavaScript). Repositories are loaded first when it names them. In the sandbox it
   * runs inside the session's transaction — as a savepoint of its own: an input that fails takes back only its own
   * writes, and on Postgres the transaction stays usable after a failed statement. As in every `transaction()`,
   * await database work in the input that starts it. In a sandbox that is not open (refused, or closed) it throws and runs nothing.
   */
  async evaluate<R>(code: string, run: () => Promise<R>): Promise<R> {
    if (/\brepos\b|Repository\b/.test(code)) await this.loadRepositories();
    // A provider's job name written out might be a repository's: while that is unknown, the input refuses with the load's error
    // and never runs a package's class in the repository's place.
    else if (code.match(/[\w$]+/g)?.some((word) => this.#fallback.has(word) && !this.#names.has(word))) await this.loadRepositories();
    const inside = this.#inside;
    // The sandbox promises a rollback: an input never runs outside its transaction (open() refused, or the session closed).
    if (this.sandbox && !inside) throw new Error('The sandbox is not open, so the input did not run (it was refused at the start or the session has ended).');
    if (!inside) return run();
    const connections = this.#connections()!;
    return inside(() => connections.transaction(() => run()));
  }

  /**
   * Resolves the app's own classes and tokens of the helpers and, with `--sandbox`, opens the transaction; call it before anything
   * else — the helpers and the banner refuse until it ran. With `--sandbox` it throws when the app's @marmeon/database cannot be used (not listed,
   * not loadable, its provider not registered) and when the installed tree holds a second copy of it, or cannot be checked for one.
   */
  async open(): Promise<void> {
    await this.#resolveOwn();
    if (!this.sandbox || this.#done) return;
    const own = this.#own();
    const problem = this.#problem(own.Connections, '--sandbox', '@marmeon/database', 'Connections');
    if (problem !== undefined) throw new Error(problem.message);
    this.#refuseSecondCopy();
    const connections = this.#connections()!;
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

  /**
   * Why {@link database} says nothing although the container binds a `Connections` of some kind: that one is not the copy of
   * `@marmeon/database` your app's `package.json` lists, so the session never uses it for the sandbox or `db` — it can still be reached by
   * `make('Connections')`. Only a warning: the name resolves nothing.
   */
  databaseWarning(): string | undefined {
    const problem = this.#problem(this.#own().Connections, 'db', '@marmeon/database', 'Connections');
    if (!problem || !this.app.container.keys().some((key) => key.name === 'Connections')) return undefined;
    const reason = { missing: '@marmeon/database is not in your package.json, or not installed', unloadable: '@marmeon/database could not be loaded', unregistered: 'its provider is not registered' }[problem.kind];
    return `db not shown (${reason}; make('Connections') may still reach one)`;
  }

  /** What the banner says about the default connection — the driver and where, never credentials. */
  database(): string | undefined {
    const connections = this.#connections();
    if (!connections) return undefined;
    const options = connections.options('default');
    switch (options.driver) {
      case 'sqlite':
        return `sqlite (${options.database})`;
      case 'pgsql':
      case 'mysql': {
        // The password is not in what is shown, but a URL that does not parse as `scheme://host/…` (an opaque path such as
        // `postgres:user:pw@h/db`) is not looked into at all.
        let url = URL.parse(options.url);
        const schemes = options.driver === 'mysql' ? ['mysql:'] : ['postgres:', 'postgresql:'];
        let path = '';
        try {
          path = url === null ? '' : decodeURIComponent(url.pathname);
        } catch {
          url = null;
        }
        // A host, or the libpq socket form `scheme:///db?host=/dir`; either way no `@` or `:` in the decoded path, where userinfo would hide (the banner masks nothing, it prints the path).
        const server = url !== null && !/[@:]/.test(path) && (url.host !== '' || (url.href.startsWith(`${url.protocol}///`) && (url.searchParams.get('host') ?? '').startsWith('/')));
        if (url === null || !server || !schemes.includes(url.protocol)) return `${options.driver} (invalid URL)`;
        return `${options.driver} (${url.host}${url.pathname})`;
      }
      default:
        throw new Error(withCode('D29', `The database driver ${JSON.stringify((options as { driver: unknown }).driver)} is not one Marmeon knows.`));
    }
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

  /**
   * Refuses the sandbox when the installed tree holds another copy of @marmeon/database than the one tinker loaded: that copy writes through a pool of
   * its own, which the sandbox's transaction cannot roll back. Refuses as well when the tree cannot be checked, and when discovery listed the package
   * more than once (one name per real directory). Reads the disk now, after boot: an install that runs in between is not seen.
   */
  #refuseSecondCopy(): void {
    const name = '@marmeon/database';
    const lead = `--sandbox refuses: ${name} is installed more than once, and writes through another copy would not be rolled back.`;
    let lines: string[];
    try {
      lines = secondCopies(this.app.root, name);
    } catch (error) {
      if (!(error instanceof UnreadableTree)) throw error;
      throw new Error(`--sandbox refuses: the install could not be checked for a second copy of ${name} (${error.message}).`);
    }
    if (lines.length === 0 && this.app.packages.filter((listed) => listed === name).length > 1) lines = [`discovery found ${name} in more than one directory`];
    if (lines.length === 0) return;
    throw new Error([lead, ...lines.map((line) => `  ${line}`), 'Install one copy: docs/package-development.md#one-copy-of-a-framework-package'].join('\n'));
  }

  #own(): OwnExports {
    if (!this.#resolved) throw new Error('TinkerSession: call open() first.');
    return this.#resolved;
  }

  /** Why the app's `key` of `pkg` is no use to `label`: no such package of the app's, one that cannot be loaded, or a provider that is not registered. Undefined when it is usable. */
  #problem(key: Own, label: string, pkg: string, name: string): { readonly kind: 'missing' | 'unloadable' | 'unregistered'; readonly message: string } | undefined {
    if (key === 'missing') return { kind: 'missing', message: `${label} needs ${pkg} in your app's package.json, installed (marmeon add ${pkg.replace('@marmeon/', '')}, or install your dependencies).` };
    if (key === 'unloadable') return { kind: 'unloadable', message: `${label} needs ${pkg}: it is installed, but it could not be loaded or lacks ${name} (reinstall it at your app's version).` };
    if (!this.app.container.has(key)) return { kind: 'unregistered', message: `${label} needs ${pkg}: it is installed, but its provider is not registered (marmeon discover).` };
    return undefined;
  }

  #connections(): SandboxConnections | undefined {
    const key = this.#own().Connections;
    return typeof key !== 'string' && this.app.container.has(key) ? (this.scope.make(key as Key<SandboxConnections>) as SandboxConnections) : undefined;
  }

  /** Finds the exports of @marmeon/database, @marmeon/queue and @marmeon/mail in the app's own copies — before the sandbox opens and the helpers are read. */
  async #resolveOwn(): Promise<void> {
    const root = this.app.root;
    const listed = listedDependencies(root);
    const [Connections, Database, Queue, Mailer] = await Promise.all([
      ownExport(root, listed, '@marmeon/database', 'Connections'),
      ownExport(root, listed, '@marmeon/database', 'Database'),
      ownExport(root, listed, '@marmeon/queue', 'Queue'),
      ownExport(root, listed, '@marmeon/mail', 'Mailer'),
    ]);
    this.#resolved = { Connections, Database, Queue, Mailer };
  }

  /** The names: what the container binds and what the modules list (jobs, notifications, seeders, listeners and their events, …), then the jobs of the providers as the last resort. */
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
    // The jobs of every provider, the ones the app lists first: read through the prototype chain, the first of a name wins.
    const listedByApp = appListedProviders(this.app);
    for (const provider of [...listedByApp, ...this.app.providers.filter((candidate) => !listedByApp.includes(candidate))]) {
      for (const job of providerJobsOf(provider)) {
        const name = typeof job === 'function' ? (job as { name?: unknown }).name : undefined;
        if (typeof name === 'string' && NAME.test(name) && !this.#fallback.has(name)) this.#fallback.set(name, job as Key);
      }
    }
    if (this.app.container.has(EventRegistry)) this.app.container.make(EventRegistry).all().forEach(fromList);
  }

  #addName(name: unknown, key: Key): void {
    if (typeof name === 'string' && NAME.test(name) && !this.#names.has(name)) this.#names.set(name, key);
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

/** A repository class (@marmeon/database): `static table` and the repository methods — told apart without importing the package. */
function isRepositoryClass(value: unknown): value is RepositoryClass {
  if (typeof value !== 'function' || typeof (value as { table?: unknown }).table !== 'string') return false;
  const prototype = (value as { prototype?: Record<string, unknown> }).prototype;
  return typeof prototype?.query === 'function' && typeof prototype.find === 'function';
}

/** A class or token name the session offers: a capital first, then word characters. */
const NAME = /^[A-Z][\w$]*$/;

function didYouMean(name: string, names: readonly string[]): string {
  const lower = name.toLowerCase();
  const close = names.filter((candidate) => candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase())).slice(0, 3);
  return close.length ? ` Did you mean ${close.map((candidate) => `"${candidate}"`).join(', ')}?` : '';
}
