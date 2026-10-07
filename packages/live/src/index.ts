import cluster from 'node:cluster';
import { Application, CLUSTER_WORKER, Logger, token, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { EncryptionConfig } from '@marmeon/encryption';
import { CONNECTION_HEADER, defineRoutes, IncomingRequest, LIVE_PATH, LiveSigner, PageSession, ReadOnly, Router, ServerClosing } from '@marmeon/http';
import { MemoryLiveBackend, type LiveBackend as Backend } from './backend.ts';
import { Broadcaster, LiveBroadcaster } from './broadcaster.ts';
import { LiveConfig } from './config.ts';
import { LiveStreamController } from './endpoint.ts';
import { LiveHub } from './hub.ts';
import { LiveChannel } from './notifications.ts';
import { BroadcastRecorder } from './recorder.ts';
import { RedisLiveBackend } from './redis.ts';
import { liveKeys, LiveTokens } from './signer.ts';

// Live props (W6.10, E89, E90, E104): a page, an island or a layer follows channels (`.live(channel, { only })` — signed for
// the session by the answer that declares them); the server hints a change (`broadcast.refresh(channel, { only })` — never
// data, after the commit, not to the tab that caused it) over one Server-Sent-Events stream per tab; the browser reloads
// `only` through the page's own route. Pub/sub in memory (one process) or over Redis (every process).
export { Broadcaster, CONNECTION_ID, LiveBroadcaster } from './broadcaster.ts';
export type { LiveBroadcasterDependencies, RefreshOptions } from './broadcaster.ts';
export { MemoryLiveBackend, parseMessage } from './backend.ts';
export type { LiveMessage, MemoryLiveOptions } from './backend.ts';
export { RedisLiveBackend } from './redis.ts';
export type { RedisLiveDependencies } from './redis.ts';
export { LiveHub, STREAM_HEADERS } from './hub.ts';
export type { LiveHello, LiveHubOptions, LiveStreamRequest } from './hub.ts';
export { LiveStreamController } from './endpoint.ts';
export { liveKeys, LiveTokens } from './signer.ts';
export { LiveConfig } from './config.ts';
export { LiveChannel, notificationsChannel } from './notifications.ts';
export { BroadcastRecorder } from './recorder.ts';
export type { RecordedRefresh } from './recorder.ts';
export { LiveStreamReader } from './test-stream.ts';
export type { LiveEvent } from './test-stream.ts';
export { CONNECTION_HEADER, LIVE_PATH } from '@marmeon/http';

/** Where this app's hints travel — `memory` or `redis` (`LIVE_DRIVER`). */
export type LiveBackend = Backend;
export const LiveBackend = token<LiveBackend>('LiveBackend');

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
 * for it, so a guest's new session is kept (E143: guests get a session only when something needs one).
 */
function sessionScopeOf(container: Resolver, keep = false): string | undefined {
  try {
    return container.make(PageSession).scope({ keep });
  } catch {
    return undefined; // no session in this app (or on this route)
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

type RedisModule = typeof import('@marmeon/redis');

/**
 * Registers the `Broadcaster`, the signer of `PageObject.live` (E90), the stream endpoint `GET /_marmeon/live` (web group,
 * read-only) and the pub/sub backend (`LIVE_DRIVER`); closes the streams of a session that ended (with @marmeon/session),
 * adds the notifications' `live` channel (with @marmeon/notifications) and closes every stream when the server or the app
 * stops. Found by `marmeon discover`.
 */
export class LiveServiceProvider implements ServiceProvider {
  static config = [LiveConfig];

  #redis: RedisModule | undefined;
  #hub: LiveHub | undefined;

  register(container: Container): void {
    container.singleton(LiveTokens, (c) => {
      const { key, previousKeys } = c.make(EncryptionConfig);
      return new LiveTokens(liveKeys(key, previousKeys));
    });
    container.singleton(LiveBackend, (c) => {
      const config = c.make(LiveConfig);
      if (config.driver === 'memory') return new MemoryLiveBackend();
      const redis = this.#redis;
      if (!redis) throw new LiveSetupError('LIVE_DRIVER=redis needs @marmeon/redis (pnpm add @marmeon/redis; marmeon discover).');
      return new RedisLiveBackend({ connection: c.make(redis.RedisConnections).get(config.redisConnection), script: redis.defineRedisScript, logger: c.make(Logger).child({ channel: 'live' }) });
    });
    container.singleton(LiveHub, (c) => {
      const { heartbeat, retry, maxStreams, maxStreamsPerSession } = c.make(LiveConfig);
      this.#hub = new LiveHub(c.make(LiveBackend), { heartbeat, retry, maxStreams, maxStreamsPerSession }, c.make(Logger).child({ channel: 'live' }), c.make(ServerClosing).signal);
      return this.#hub;
    });
    // Signs the channels a page follows for the session of its request (E90).
    // A read-only request (an island) cannot keep a session for the signature: a guest without one gets no subscription there.
    container.scoped(LiveSigner, (c) => c.make(LiveTokens).for(() => sessionScopeOf(c, true), () => readOnlyRequest(c)));
    // Per resolution: in a request it knows the tab that sent it (x-marmeon-connection); in a job or a command, none.
    container.bind(Broadcaster, (c) => {
      const recorder = container.has(BroadcastRecorder) ? container.make(BroadcastRecorder) : undefined;
      return new LiveBroadcaster({ backend: () => container.make(LiveBackend), connection: connectionOf(c), logger: c.make(Logger).child({ channel: 'live' }), recorder, app: c.make(Application) });
    });
    container.scoped(LiveStreamController, (c) => new LiveStreamController(c.make(LiveHub), c.make(LiveTokens), c.make(LiveConfig).maxChannels, () => sessionScopeOf(c)));
  }

  async boot(app: Application): Promise<void> {
    const { container } = app;
    const config = container.make(LiveConfig);
    // A worker of `marmeon start --workers=N` (E140): with the memory backend a hint reaches the streams of its own worker only,
    // and a stream that reconnects to another worker compares its sequences with another counter — live updates would go
    // missing without a sound. The start fails instead (W9 step 4).
    if (config.driver === 'memory' && process.env[CLUSTER_WORKER] === '1' && cluster.isWorker) {
      throw new LiveSetupError(
        'LIVE_DRIVER=memory cannot serve marmeon start --workers: memory pub/sub never reaches the other workers — use LIVE_DRIVER=redis (with @marmeon/redis), or start one process without --workers.',
      );
    }
    if (config.driver === 'redis') {
      this.#redis = await importOptional(() => import('@marmeon/redis'), '@marmeon/redis');
      if (!this.#redis || !container.has(this.#redis.RedisConnections)) {
        throw new LiveSetupError('LIVE_DRIVER=redis needs @marmeon/redis and its provider (pnpm add @marmeon/redis; marmeon discover).');
      }
      // An unknown connection name fails the start, with the known ones.
      container.make(this.#redis.RedisConnections).options(config.redisConnection);
    }
    // The keys come from APP_KEY: a missing key fails the start, not the first page.
    container.make(LiveTokens);

    // The stream: in the web group (the session says whose it is), read-only by its path (the kernel, LIVE_PATH).
    container.make(Router).load(
      { group: 'web' },
      defineRoutes((Route) => {
        Route.get(LIVE_PATH, LiveStreamController);
      }),
    );

    // Signed in or out (the session's id regenerated): the streams of the old session close — in every process.
    const session = await importOptional(() => import('@marmeon/session'), '@marmeon/session');
    if (session && container.has(session.SessionEndings)) {
      const logger = container.make(Logger).child({ channel: 'live' });
      container.make(session.SessionEndings).listen(async (scope) => {
        try {
          await container.make(LiveBackend).end(scope);
        } catch (error) {
          logger.error('The streams of a session that ended could not be closed (the live backend failed)', { exception: String(error) });
        }
      });
    }

    // Notifications (E92): the `live` channel — a hint on the recipient's channel once the delivery committed.
    const notifications = await importOptional(() => import('@marmeon/notifications'), '@marmeon/notifications');
    if (notifications && container.has(notifications.NotificationChannels)) {
      container.make(notifications.NotificationChannels).add('live', (scope) => new LiveChannel(scope.make(Broadcaster)));
    }
  }

  async shutdown(): Promise<void> {
    await this.#hub?.close();
  }
}
