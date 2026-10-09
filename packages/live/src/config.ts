import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/**
 * Live props (W6.10, E89, E104):
 *
 * ```sh
 * LIVE_DRIVER=memory            # memory (one process) | redis (every process hears every hint — E89)
 * LIVE_REDIS_CONNECTION=default # the Redis connection of the redis driver
 * LIVE_HEARTBEAT=20             # seconds between heartbeats on an idle stream — under every proxy's idle timeout
 * LIVE_RETRY=3000               # how long a browser waits before it reconnects a stream that broke (ms, `retry:`)
 * LIVE_MAX_STREAMS=1000         # open streams per process — beyond, a new one is refused (503) until one closes
 * LIVE_MAX_STREAMS_PER_SESSION=16 # open streams of one session per process (its tabs) — beyond, 429 (W9 step 4)
 * LIVE_MAX_CHANNELS=20          # channels per stream (one page, its islands and layers)
 * ```
 */
export const LiveConfig = defineConfig('live', {
  env: env({
    LIVE_DRIVER: env.in(['memory', 'redis'], 'Expected memory or redis').default('memory'),
    LIVE_REDIS_CONNECTION: env.string().default('default'),
    LIVE_HEARTBEAT: env.integer().min(1).max(300).default(20),
    LIVE_RETRY: env.integer().min(100).max(600_000).default(3000),
    LIVE_MAX_STREAMS: env.integer().min(1).default(1000),
    LIVE_MAX_STREAMS_PER_SESSION: env.integer().min(1).default(16),
    LIVE_MAX_CHANNELS: env.integer().min(1).max(200).default(20),
  }),
  resolve: (e) => ({
    driver: e.LIVE_DRIVER,
    redisConnection: e.LIVE_REDIS_CONNECTION,
    heartbeat: e.LIVE_HEARTBEAT,
    retry: e.LIVE_RETRY,
    maxStreams: e.LIVE_MAX_STREAMS,
    maxStreamsPerSession: e.LIVE_MAX_STREAMS_PER_SESSION,
    maxChannels: e.LIVE_MAX_CHANNELS,
  }),
});
export type LiveConfig = ConfigOf<typeof LiveConfig>;
