import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/**
 * Live props: how hints travel (`memory` in one process, `redis` to every process), the heartbeat, the reconnect delay
 * and the stream limits. See `docs/realtime.md#configuration`.
 */
export const LiveConfig = defineConfig('live', {
  env: env({
    LIVE_DRIVER: env.in(['memory', 'redis'], 'Expected memory or redis').default('memory'),
    LIVE_REDIS_CONNECTION: env.string().default('default'),
    LIVE_HEARTBEAT: env.integer().min(1).max(300).default(20),
    LIVE_RETRY: env.integer().min(100).max(600_000).default(3000),
    LIVE_MAX_STREAMS: env.integer().min(1).default(1000),
    LIVE_MAX_STREAMS_PER_SESSION: env.integer().min(1).default(16),
    LIVE_MAX_STREAM_SECONDS: env.integer().min(30).max(86_400).default(900),
    LIVE_MAX_CHANNELS: env.integer().min(1).max(200).default(20),
  }),
  resolve: (e) => ({
    driver: e.LIVE_DRIVER,
    redisConnection: e.LIVE_REDIS_CONNECTION,
    heartbeat: e.LIVE_HEARTBEAT,
    retry: e.LIVE_RETRY,
    maxStreams: e.LIVE_MAX_STREAMS,
    maxStreamsPerSession: e.LIVE_MAX_STREAMS_PER_SESSION,
    maxStreamSeconds: e.LIVE_MAX_STREAM_SECONDS,
    maxChannels: e.LIVE_MAX_CHANNELS,
  }),
});
export type LiveConfig = ConfigOf<typeof LiveConfig>;
