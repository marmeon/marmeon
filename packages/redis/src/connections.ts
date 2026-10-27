import { createHash } from 'node:crypto';
import { Redactor, type Logger } from '@marmeon/core';
import { maskUrlPasswords } from '@marmeon/core/internal';

/** Where a connection points: `redis://[[user]:password@]host[:port][/db]` (`rediss://` for TLS), and the prefix of its keys. */
export interface RedisConnectionOptions {
  readonly url: string;
  /** Put in front of every key and channel through {@link RedisConnection.key} — apps sharing one Redis stay apart. */
  readonly prefix: string;
}

/**
 * A Lua script, run atomically by Redis. Defined once at module scope and run by its hash (`EVALSHA`); the script itself
 * is sent only when this Redis does not know it yet (after a restart or `SCRIPT FLUSH`). See `docs/redis.md#using-redis-yourself`.
 */
export interface RedisScript {
  readonly name: string;
  readonly lua: string;
  readonly sha: string;
}

export function defineRedisScript(name: string, lua: string): RedisScript {
  return Object.freeze({ name, lua, sha: createHash('sha1').update(lua).digest('hex') });
}

/**
 * The part of node-redis this package uses — its own types never reach the API, and a new major of the client changes one
 * file.
 */
interface Client {
  connect(): Promise<unknown>;
  sendCommand(args: string[]): Promise<unknown>;
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  close(): Promise<unknown>;
  destroy(): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
interface ClientModule {
  createClient(options: Record<string, unknown>): Client;
}

/** node-redis, a dependency of this package, imported on first use: an app whose drivers never talk to Redis never loads it. */
async function loadClient(): Promise<ClientModule> {
  const module = (await import('redis')) as unknown as Partial<ClientModule> & { default?: Partial<ClientModule> };
  const createClient = module.createClient ?? module.default?.createClient;
  if (typeof createClient !== 'function') throw new TypeError('The "redis" package this one depends on has no createClient() — a broken install? (pnpm install)');
  return { createClient };
}

/**
 * One Redis connection (a socket), opened on its first command. Keys are not prefixed for you — commands are raw —
 * so name them with {@link key}: `connection.command(['GET', connection.key('stats')])`.
 *
 * Fails fast: an unreachable Redis rejects the first command (no endless waiting in a request), and while a lost
 * connection reconnects, commands fail instead of queueing.
 */
export class RedisConnection {
  readonly name: string;
  readonly prefix: string;
  readonly #options: RedisConnectionOptions;
  readonly #load: () => Promise<ClientModule>;
  readonly #logger: Logger;
  readonly #redactor: Redactor;
  readonly #track: (connection: RedisConnection) => void;
  #client: Promise<Client> | undefined;
  #closed = false;

  /** @internal Built by `RedisConnections`. */
  constructor(
    name: string,
    options: RedisConnectionOptions,
    internals: { load: () => Promise<ClientModule>; logger: Logger; redactor: Redactor; track: (connection: RedisConnection) => void },
  ) {
    this.name = name;
    this.prefix = options.prefix;
    this.#options = options;
    this.#load = internals.load;
    this.#logger = internals.logger;
    this.#redactor = internals.redactor;
    this.#track = internals.track;
  }

  /** The key (or channel) with this connection's prefix: `key('cache:hits')` → `myapp:cache:hits`. */
  key(name: string): string {
    return this.prefix + name;
  }

  /** Any Redis command, raw: `command(['SET', key, value, 'NX', 'PX', '5000'])`. Numbers are sent as strings. */
  async command<T = unknown>(args: readonly (string | number)[]): Promise<T> {
    return (await (await this.#connect()).sendCommand(args.map(String))) as T;
  }

  /** Runs a named script ({@link defineRedisScript}) atomically: by hash, loading it first when Redis does not know it. */
  async run<T = unknown>(script: RedisScript, keys: readonly string[], args: readonly (string | number)[] = []): Promise<T> {
    const rest = [String(keys.length), ...keys, ...args.map(String)];
    try {
      return await this.command<T>(['EVALSHA', script.sha, ...rest]);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
      return this.command<T>(['EVAL', script.lua, ...rest]);
    }
  }

  /**
   * A second connection to the same Redis, with the same prefix — for what blocks a socket: `SUBSCRIBE`, blocking pops.
   * Closed with the others on shutdown.
   */
  duplicate(): RedisConnection {
    const copy = new RedisConnection(this.name, this.#options, { load: this.#load, logger: this.#logger, redactor: this.#redactor, track: this.#track });
    this.#track(copy);
    return copy;
  }

  /**
   * Listens on a channel (the name as given — prefix it with {@link key}). The connection becomes a subscriber and
   * runs no other commands: use a {@link duplicate}. Returns a function that stops listening.
   */
  async subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> {
    const client = await this.#connect();
    await client.subscribe(channel, (message) => listener(message));
    return async () => {
      if (!this.#closed) await client.unsubscribe(channel);
    };
  }

  /** Closes the socket (waits for replies in flight). Later commands throw. */
  async close(): Promise<void> {
    this.#closed = true;
    const client = await this.#client?.catch(() => undefined);
    this.#client = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch {
      client.destroy();
    }
  }

  #connect(): Promise<Client> {
    if (this.#closed) return Promise.reject(new Error(`The Redis connection "${this.name}" is closed (the application shut down).`));
    this.#client ??= this.#open().catch((error: unknown) => {
      this.#client = undefined; // the next command tries again
      throw error;
    });
    return this.#client;
  }

  async #open(): Promise<Client> {
    const { createClient } = await this.#load();
    let connected = false;
    const client = createClient({
      url: this.#options.url,
      // A command while the connection is down fails at once instead of waiting in a queue (a request would hang).
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5_000,
        // The first connect fails fast (Redis down, wrong URL); a lost connection is retried, at most every 2 s.
        reconnectStrategy: (retries: number, cause: Error) => (connected ? Math.min(50 * 2 ** retries, 2_000) : cause),
      },
    });
    // Without a listener, a connection error would crash the process.
    client.on('error', (error) => {
      // The driver's text is masked by the app's Redactor, like every error line of the framework.
      if (connected) this.#logger.warn('The Redis connection failed; reconnecting', { connection: this.name, error: this.#redactor.text(error.message) });
    });
    try {
      await client.connect();
    } catch (error) {
      try {
        client.destroy();
      } catch {
        // Already closed by the failed connect.
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not connect to Redis "${this.name}" (${describeRedisUrl(this.#options.url)}): ${reason}`, { cause: error });
    }
    connected = true;
    return client;
  }
}

/** For messages: the URL with its password masked. */
export function describeRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    // A password with a raw `/` or `@` ends the userinfo early: what the parser took for the path still holds a rest of it.
    return maskUrlPasswords(parsed.href);
  } catch {
    return '(invalid URL)';
  }
}

/**
 * The app's Redis connections, opened on first use and closed on shutdown: `redis.get()` is `default` (from `REDIS_URL`),
 * `redis.get('queue')` one of {@link defineRedisConnection}.
 */
export class RedisConnections {
  readonly #options: ReadonlyMap<string, RedisConnectionOptions>;
  readonly #logger: Logger;
  readonly #redactor: Redactor;
  readonly #load: () => Promise<ClientModule>;
  readonly #instances = new Map<string, RedisConnection>();
  readonly #duplicates = new Set<RedisConnection>();
  #client: Promise<ClientModule> | undefined;
  #closed = false;

  /**
   * `redactor` masks a connection's failure in the log — the app's, so the names its packages add count; without one, the core's key list.
   * @internal Built by the container, which applies the connections' key prefix.
   */
  constructor(options: { connections: Readonly<Record<string, RedisConnectionOptions>>; logger: Logger; redactor?: Redactor }) {
    this.#options = new Map(Object.entries(options.connections));
    this.#logger = options.logger.child({ channel: 'redis' });
    this.#redactor = options.redactor ?? new Redactor();
    this.#load = () =>
      (this.#client ??= loadClient().catch((error: unknown) => {
        this.#client = undefined;
        throw error;
      }));
  }

  /** The connection by name (default: `default`, from `REDIS_URL`). Nothing connects until its first command. */
  get(name = 'default'): RedisConnection {
    if (this.#closed) throw new Error(`The Redis connections are closed (the application shut down); cannot use "${name}".`);
    let connection = this.#instances.get(name);
    if (!connection) {
      connection = new RedisConnection(name, this.options(name), { load: this.#load, logger: this.#logger, redactor: this.#redactor, track: (copy) => this.#duplicates.add(copy) });
      this.#instances.set(name, connection);
    }
    return connection;
  }

  options(name = 'default'): RedisConnectionOptions {
    const options = this.#options.get(name);
    if (!options) {
      throw new Error(
        `Redis connection "${name}" is not configured. Known: ${this.names().join(', ')}. Add one with defineRedisConnection('${name}', …) in the app's config.`,
      );
    }
    return options;
  }

  /** Names of every configured connection. */
  names(): string[] {
    return [...this.#options.keys()];
  }

  /** @internal Names of the connections the app uses — asked for with `get()` by a driver or the app — in that order. */
  inUse(): string[] {
    return [...this.#instances.keys()];
  }

  /**
   * Checks what can be checked without connecting: loads the client. Drivers call it when they boot, so a broken install
   * fails the start, not the first request; an unreachable Redis is noticed by the first command.
   * @internal
   */
  async verify(): Promise<void> {
    await this.#load();
  }

  /** @internal Closes every opened connection, duplicates included. Later `get()` calls throw. */
  async close(): Promise<void> {
    this.#closed = true;
    const connections = [...this.#instances.values(), ...this.#duplicates];
    this.#instances.clear();
    this.#duplicates.clear();
    await Promise.all(connections.map((connection) => connection.close()));
  }
}
