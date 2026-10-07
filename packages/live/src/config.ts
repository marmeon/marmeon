import { defineConfig, type ConfigOf } from '@marmeon/core';
import * as v from 'valibot';

const NUMBER = v.pipe(v.string(), v.transform(Number), v.integer());

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
  env: v.object({
    LIVE_DRIVER: v.optional(v.picklist(['memory', 'redis'], 'Expected memory or redis'), 'memory'),
    LIVE_REDIS_CONNECTION: v.optional(v.pipe(v.string(), v.nonEmpty()), 'default'),
    LIVE_HEARTBEAT: v.optional(v.pipe(NUMBER, v.minValue(1), v.maxValue(300)), '20'),
    LIVE_RETRY: v.optional(v.pipe(NUMBER, v.minValue(100), v.maxValue(600_000)), '3000'),
    LIVE_MAX_STREAMS: v.optional(v.pipe(NUMBER, v.minValue(1)), '1000'),
    LIVE_MAX_STREAMS_PER_SESSION: v.optional(v.pipe(NUMBER, v.minValue(1)), '16'),
    LIVE_MAX_CHANNELS: v.optional(v.pipe(NUMBER, v.minValue(1), v.maxValue(200)), '20'),
  }),
  resolve: (env) => ({
    driver: env.LIVE_DRIVER,
    redisConnection: env.LIVE_REDIS_CONNECTION,
    heartbeat: env.LIVE_HEARTBEAT,
    retry: env.LIVE_RETRY,
    maxStreams: env.LIVE_MAX_STREAMS,
    maxStreamsPerSession: env.LIVE_MAX_STREAMS_PER_SESSION,
    maxChannels: env.LIVE_MAX_CHANNELS,
  }),
});
export type LiveConfig = ConfigOf<typeof LiveConfig>;
