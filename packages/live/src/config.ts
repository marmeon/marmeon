import { defineConfig, env, type ConfigOf } from '@marmeon/core';
import { deprecated } from '@marmeon/core/deprecation';

/**
 * Live props: how hints travel (`memory` in one process, `database` through the app's database, `redis` to every process), the
 * heartbeat, the reconnect delay and the stream limits. See `docs/realtime.md#configuration`.
 */
export const LiveConfig = defineConfig('live', {
  env: env({
    LIVE_DRIVER: env.in(['memory', 'database', 'redis'], 'Expected memory, database or redis').default('memory'),
    /** The database or Redis connection of the `database` and `redis` drivers. */
    LIVE_CONNECTION: env.string().default('default'),
    /** How often the `database` driver looks for hints of other processes, in milliseconds. */
    LIVE_POLL_MILLISECONDS: env.integer().min(50).max(10_000).default(500),
    LIVE_HEARTBEAT_SECONDS: env.integer().min(1).max(300).default(20),
    LIVE_RETRY_MILLISECONDS: env.integer().min(100).max(600_000).default(3000),
    LIVE_MAX_STREAMS: env.integer().min(1).default(1000),
    LIVE_MAX_STREAMS_PER_SESSION: env.integer().min(1).default(16),
    LIVE_MAX_STREAM_SECONDS: env.integer().min(30).max(86_400).default(900),
    LIVE_MAX_CHANNELS: env.integer().min(1).max(200).default(20),
  })
    .renamed('LIVE_REDIS_CONNECTION', 'LIVE_CONNECTION')
    .renamed('LIVE_HEARTBEAT', 'LIVE_HEARTBEAT_SECONDS')
    .renamed('LIVE_RETRY', 'LIVE_RETRY_MILLISECONDS'),
  resolve: (e) => {
    const resolved = {
      driver: e.LIVE_DRIVER,
      connection: e.LIVE_CONNECTION,
      /** @deprecated Use `connection`, the same value: it names the `database` driver's connection too. Removed in 2.0; docs/realtime.md#configuration. */
      redisConnection: e.LIVE_CONNECTION,
      pollMs: e.LIVE_POLL_MILLISECONDS,
      heartbeatSeconds: e.LIVE_HEARTBEAT_SECONDS,
      retryMs: e.LIVE_RETRY_MILLISECONDS,
      maxStreams: e.LIVE_MAX_STREAMS,
      maxStreamsPerSession: e.LIVE_MAX_STREAMS_PER_SESSION,
      maxStreamSeconds: e.LIVE_MAX_STREAM_SECONDS,
      maxChannels: e.LIVE_MAX_CHANNELS,
    };
    // Not enumerable: copying or printing the config does not read it. Reading it warns once, in development and tests.
    return Object.defineProperty(resolved, 'redisConnection', {
      enumerable: false,
      configurable: true,
      // An app that assigns it keeps a plain value: later reads neither warn nor see the environment's.
      set(value: string) {
        Object.defineProperty(resolved, 'redisConnection', { value, writable: true, enumerable: false, configurable: true });
      },
      get() {
        deprecated('live.redis-connection', 'LiveConfig.redisConnection is deprecated, use LiveConfig.connection instead.', '2.0');
        return e.LIVE_CONNECTION;
      },
    });
  },
});
export type LiveConfig = ConfigOf<typeof LiveConfig>;
