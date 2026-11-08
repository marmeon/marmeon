import cluster from 'node:cluster';
import type { ProviderMigrations } from '@marmeon/database';
import { afterCommit, afterRollback, Application, Clock, HealthChecks, Logger, outsideTransaction, Redactor, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { CLUSTER_WORKER, withCode } from '@marmeon/core/internal';
import type { CommandClass } from 'marmeon';
import { EncryptionConfig } from '@marmeon/encryption';
import { defineRoutes, LiveAudience, Router, type LiveAuthorizerClass } from '@marmeon/http';
import { FRAMEWORK_ROUTES, IncomingRequest, CONNECTION_HEADER, LIVE_PATH, LiveSigner, PageSession, ReadOnly, ServerClosing, ServerServing } from '@marmeon/http/internal';
import { LiveBackend, MemoryLiveBackend } from './backend.ts';
import { Broadcaster, LiveBroadcaster } from './broadcaster.ts';
import { MakeLiveTableCommand } from './commands/make-live-table.ts';
import { LiveConfig } from './config.ts';
import { DatabaseLiveBackend, LIVE_HINTS_COLUMNS, LIVE_HINTS_TABLE } from './database.ts';
import { LiveTableHealthCheck } from './table-check.ts';
import { LiveStreamController } from './endpoint.ts';
import { LiveHub } from './hub.ts';
import { LiveChannel } from './notifications.ts';
import { BroadcastTester } from './recorder.ts';
import { RedisLiveBackend } from './redis.ts';
import { liveKeys, LiveTokens } from './signer.ts';

export { Broadcaster } from './broadcaster.ts';
export type { RefreshOptions } from './broadcaster.ts';
export type { LiveHello } from './hub.ts';
export { LiveConfig } from './config.ts';
export { notificationsChannel } from './notifications.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** The module's live authorizers — classes with `allows(channel, ctx)`, asked at every connection of a stream. See docs/realtime.md#who-may-follow-a-channel. */
    readonly liveAuthorizers?: readonly LiveAuthorizerClass[];
  }
}

const DATABASE_NEEDED =
  'LIVE_DRIVER=database needs @marmeon/database and its provider (pnpm add -E @marmeon/database@<version of your app>; marmeon discover), and the live_hints table: marmeon make:live-table && marmeon migrate.';

/** Live props need a piece the app does not have. */
export class LiveSetupError extends Error {
  override name = 'LiveSetupError';
}

/** An optional peer — undefined when it is not installed. */
async function importOptional<T>(load: () => Promise<T>, name: string): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes(name)) return undefined;
    throw error;
  }
}

/**
 * The session's scope of the current request (a hash of its id) — undefined without a session. `keep`: a page signs a channel
 * for it, so a guest's new session is kept (guests get a session only when something needs one).
 */
function sessionScopeOf(container: Resolver, keep = false): string | undefined {
  try {
    return container.make(PageSession).scope({ keep });
  } catch {
    return undefined; // no session in this app (or on this route)
  }
}

/** When the request's session began to be read (see `PageSession.readAt`); undefined without a session. */
function sessionReadAtOf(container: Resolver): number | undefined {
  try {
    return container.make(PageSession).readAt();
  } catch {
    return undefined;
  }
}

/** Whether the current request is read-only (an island, an upload, a stream) — it can start no session. */
function readOnlyRequest(container: Resolver): boolean {
  try {
    return container.make(ReadOnly).active;
  } catch {
    return false; // outside a request (a job, a command)
  }
}

/** The tab that sent the current request — undefined outside a request (a job, a command) or when it names none. */
function connectionOf(container: Resolver): string | undefined {
  try {
    return container.make(IncomingRequest).headers.get(CONNECTION_HEADER) ?? undefined;
  } catch {
    return undefined; // not in a request
  }
}

/**
 * Runs `send` once the transaction around the caller is over — committed or rolled back, since a session that ended stays ended
 * (as `Auth` announces it) — and at once outside a transaction. A failure goes to `onError`, never to the caller's `transaction()`. Written on the infrastructure connection, which an open
 * transaction on SQLite would refuse. Only once, though a savepoint's rollback and the final commit both come.
 */
async function afterTransaction(send: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  let done = false;
  const run = async () => {
    if (done) return;
    try {
      await outsideTransaction(send);
      done = true;
    } catch (error) {
      // Logged, never thrown: a hook that throws would replace the error of the app's own rollback.
      onError(error);
    }
  };
  await afterRollback(run);
  await afterCommit(run);
}

type RedisModule = typeof import('@marmeon/redis');
type DatabaseModule = typeof import('@marmeon/database');

/** For messages of the database: who uses its infrastructure connection, and what to do on a shared SQLite file. */
const LIVE_INFRASTRUCTURE = {
  system: 'Live updates (LIVE_DRIVER=database)',
  remedy:
    'Give live updates their own SQLite file — LIVE_CONNECTION=system with a connection for storage/system.sqlite, then marmeon migrate (the migration of `marmeon make:live-table` follows LIVE_CONNECTION) — or use Redis (LIVE_DRIVER=redis).',
};

/**
 * The connection the `live_hints` table belongs on — for the migration `marmeon make:live-table` writes (`connection` in
 * `defineMigration`): `LIVE_CONNECTION` with the database driver, else `default`.
 */
export function liveTableConnection(container: Resolver): string {
  const config = container.make(LiveConfig);
  return config.driver === 'database' ? config.connection : 'default';
}

/**
 * Registers the `Broadcaster`, the signer of `PageObject.live`, the stream endpoint `GET /_marmeon/live` (web group,
 * read-only) and the pub/sub backend (`LIVE_DRIVER`); closes the streams of a session that ended (with @marmeon/session),
 * adds the notifications' `live` channel (with @marmeon/notifications) and closes every stream when the server or the app
 * stops. Found by `marmeon discover`.
 */
export class LiveServiceProvider implements ServiceProvider {
  static config = [LiveConfig];
  static commands: readonly CommandClass[] = [MakeLiveTableCommand];
  /** The migration for the `live_hints` table, which `marmeon publish` and `make:live-table` copy into the app. */
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'system' } satisfies ProviderMigrations;

  #redis: RedisModule | undefined;
  #database: DatabaseModule | undefined;
  #hub: LiveHub | undefined;

  register(container: Container): void {
    container.singleton(LiveTokens, (c) => {
      const { key, previousKeys } = c.make(EncryptionConfig);
      return new LiveTokens(liveKeys(key, previousKeys));
    });
    container.singleton(LiveBackend, (c) => {
      const config = c.make(LiveConfig);
      if (config.driver === 'memory') return new MemoryLiveBackend();
      if (config.driver === 'database') {
        const database = this.#database;
        if (!database) throw new LiveSetupError(withCode('H7', DATABASE_NEEDED));
        return new DatabaseLiveBackend(
          async () => {
            const connections = c.make(database.Connections);
            return { db: connections.infrastructure(config.connection, LIVE_INFRASTRUCTURE), driver: connections.options(config.connection).driver };
          },
          { pollMs: config.pollMs, logger: c.make(Logger).child({ channel: 'live' }), redactor: c.make(Redactor), clock: c.make(Clock) },
        );
      }
      const redis = this.#redis;
      if (!redis) throw new LiveSetupError(withCode('H7', 'LIVE_DRIVER=redis needs @marmeon/redis (pnpm add -E @marmeon/redis@<version of your app>; marmeon discover).'));
      return new RedisLiveBackend({ connection: c.make(redis.RedisConnections).get(config.connection), script: redis.defineRedisScript, logger: c.make(Logger).child({ channel: 'live' }) });
    });
    container.singleton(LiveHub, (c) => {
      const { heartbeatSeconds, retryMs, maxStreams, maxStreamsPerSession, maxStreamSeconds } = c.make(LiveConfig);
      this.#hub = new LiveHub(c.make(LiveBackend), { heartbeatSeconds, retryMs, maxStreams, maxStreamsPerSession, maxStreamSeconds }, c.make(Logger).child({ channel: 'live' }), c.make(ServerClosing).signal, c.make(Redactor));
      return this.#hub;
    });
    // Signs the channels a page follows for the session of its request.
    // A read-only request (an island) cannot keep a session for the signature: a guest without one gets no subscription there.
    container.scoped(LiveSigner, (c) => c.make(LiveTokens).for(() => sessionScopeOf(c, true), () => readOnlyRequest(c)));
    // Per resolution: in a request it knows the tab that sent it (x-marmeon-connection); in a job or a command, none.
    container.bind(Broadcaster, (c) => {
      const recorder = container.has(BroadcastTester) ? container.make(BroadcastTester) : undefined;
      return new LiveBroadcaster({ backend: () => container.make(LiveBackend), connection: connectionOf(c), logger: c.make(Logger).child({ channel: 'live' }), recorder, app: c.make(Application), redactor: c.make(Redactor) });
    });
    container.scoped(LiveStreamController, (c) => new LiveStreamController(c.make(LiveHub), c.make(LiveTokens), c.make(LiveConfig).maxChannels, () => sessionScopeOf(c), container.has(LiveAudience) ? c.make(LiveAudience) : undefined, c.make(Logger).child({ channel: 'live' }), c.make(Redactor), () => [...new Set(c.make(Application).modules.flatMap((module) => module.liveAuthorizers ?? []))].map((authorizer) => c.make(authorizer)), () => sessionReadAtOf(c)));
  }

  async boot(app: Application): Promise<void> {
    const { container } = app;
    const config = container.make(LiveConfig);
    // A worker of `marmeon start --workers=N`: with the memory backend a hint reaches the streams of its own worker only,
    // and a stream that reconnects to another worker compares its sequences with another counter — live updates would go
    // missing without a sound. The start fails instead.
    if (config.driver === 'memory' && process.env[CLUSTER_WORKER] === '1' && cluster.isWorker) {
      throw new LiveSetupError(
        withCode(
          'H7',
          'LIVE_DRIVER=memory cannot serve marmeon start --workers: memory pub/sub never reaches the other workers — use LIVE_DRIVER=database (one machine, or a shared Postgres) or LIVE_DRIVER=redis (with @marmeon/redis), or start one process without --workers.',
        ),
      );
    }
    if (config.driver === 'database') {
      this.#database = await importOptional(() => import('@marmeon/database'), '@marmeon/database');
      if (!this.#database || !container.has(this.#database.Connections)) throw new LiveSetupError(withCode('H7', DATABASE_NEEDED));
      // An unknown connection name fails the start, with the known ones (D11). A missing table does not: /up/ready is red and
      // `marmeon check` says so, until `marmeon make:live-table && marmeon migrate`.
      container.make(this.#database.Connections).options(config.connection);
      container.make(this.#database.SchemaRequirements).require({ connection: config.connection, table: LIVE_HINTS_TABLE, columns: LIVE_HINTS_COLUMNS });
      container.make(HealthChecks).add([LiveTableHealthCheck]);
    }
    if (config.driver === 'redis') {
      this.#redis = await importOptional(() => import('@marmeon/redis'), '@marmeon/redis');
      if (!this.#redis || !container.has(this.#redis.RedisConnections)) {
        throw new LiveSetupError(withCode('H7', 'LIVE_DRIVER=redis needs @marmeon/redis and its provider (pnpm add -E @marmeon/redis@<version of your app>; marmeon discover).'));
      }
      // An unknown connection name fails the start, with the known ones — and so does a client that cannot load (a broken
      // install), as for the cache, the sessions and the queue: not the first hint.
      const connections = container.make(this.#redis.RedisConnections);
      connections.options(config.connection);
      await connections.verify();
    }
    // Subscribed before the process takes requests: an end that comes while a stream opens is then heard. If the backend is down now
    // the server starts anyway (logged); streams are then asked to connect again and the next one retries the subscription.
    if (container.has(ServerServing)) {
      const logger = container.make(Logger).child({ channel: 'live' });
      const redactor = container.make(Redactor);
      container.make(ServerServing).onServe(async (deadlineMs) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          // A backend that never answers the subscription must not keep the port closed: the subscription goes on in the hub, which
          // counts streams as blind (they connect again) until it settles.
          const timedOut = new Promise<'late'>((resolve) => (timer = setTimeout(resolve, deadlineMs, 'late')));
          if ((await Promise.race([container.make(LiveHub).listen(), timedOut])) === 'late') logger.error(`The live backend did not answer the subscription within ${deadlineMs} ms; the server starts, streams connect again until it does`);
        } catch (error) {
          logger.error('The live backend could not be subscribed to at start; streams retry it as they open', { exception: redactor.text(String(error)) });
        } finally {
          clearTimeout(timer);
        }
      });
    }
    // The keys come from APP_KEY: a missing key fails the start, not the first page.
    container.make(LiveTokens);

    // The stream: in the web group (the session says whose it is), read-only by its path (the kernel, LIVE_PATH).
    container.make(Router).load(
      { group: 'web', framework: FRAMEWORK_ROUTES },
      defineRoutes((Route) => {
        Route.get(LIVE_PATH, LiveStreamController);
      }),
    );

    // Signed in or out (the session's id regenerated): the streams of the old session close — in every process.
    const session = await importOptional(() => import('@marmeon/session'), '@marmeon/session');
    if (session && container.has(session.SessionEndings)) {
      const logger = container.make(Logger).child({ channel: 'live' });
      const redactor = container.make(Redactor);
      container.make(session.SessionEndings).listen(async (scope) => {
        const failed = (error: unknown) => logger.error('The streams of a session that ended could not be closed (the live backend failed)', { exception: redactor.text(String(error)) });
        try {
          await afterTransaction(() => container.make(LiveBackend).end(scope), failed);
        } catch (error) {
          failed(error);
        }
      });
    }

    // Sign-ins of an account ended (`AccountSessions`, a new password, an ended sign-in): its streams close, in every process. The browsers
    // still signed in connect again and are checked; the others are told `end`. The backend carries the keyed scope, never the account's own.
    if (session && container.has(session.SessionEndings)) {
      const logger = container.make(Logger).child({ channel: 'live' });
      const redactor = container.make(Redactor);
      container.make(session.SessionEndings).listenAccounts(async (scope) => {
        const failed = (error: unknown) => logger.error('The streams of an account could not be closed (the live backend failed)', { exception: redactor.text(String(error)) });
        try {
          // One message per key (`APP_KEY` and the previous ones): streams are filed under every key too, so a process on another key of a rollout hears it, whichever way round.
          const scopes = scope === '*' ? ['*'] : container.make(LiveTokens).accountScopes(scope);
          for (const keyed of scopes) await afterTransaction(() => container.make(LiveBackend).end(keyed), failed);
        } catch (error) {
          failed(error);
        }
      });
    }

    // Notifications: the `live` channel — a hint on the recipient's channel once the delivery committed.
    const notifications = await importOptional(() => import('@marmeon/notifications'), '@marmeon/notifications');
    if (notifications && container.has(notifications.NotificationChannels)) {
      container.make(notifications.NotificationChannels).add('live', (scope) => new LiveChannel(scope.make(Broadcaster)));
    }
  }

  async shutdown(): Promise<void> {
    await this.#hub?.close();
  }
}
