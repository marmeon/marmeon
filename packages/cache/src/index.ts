import { isAbsolute, join } from 'node:path';
import { Application, defineConfig, type ConfigOf, type Container, type ServiceProvider } from '@bespokecore/core';
import { GLOBAL, MiddlewarePriority, Router } from '@bespokecore/router';
import * as v from 'valibot';
import { Cache, FileStore, MemoryStore, StoreCache } from './cache.ts';
import { LimitLiveValidation, RateLimiter } from './rate-limiter.ts';

export { Cache, FileStore, MemoryStore, StoreCache } from './cache.ts';
export type { CacheStore } from './cache.ts';
export { DEFAULT_LIVE_VALIDATION_LIMIT, Limit, LimitLiveValidation, LIVE_VALIDATION_LIMITER, RateLimiter, throttle } from './rate-limiter.ts';
export type { LimiterCallback } from './rate-limiter.ts';

export const CacheConfig = defineConfig('cache', {
  env: v.object({
    /** `file` (default, shared by processes on one machine, survives restarts) or `memory` (tests, one process). */
    CACHE_DRIVER: v.optional(v.picklist(['file', 'memory']), 'file'),
    /** Where the `file` driver keeps entries, relative to the app root. */
    CACHE_PATH: v.optional(v.string(), 'storage/framework/cache'),
    /** Prepended to every key — apps sharing a store stay apart. */
    CACHE_PREFIX: v.optional(v.string(), ''),
  }),
  resolve: (env) => ({ driver: env.CACHE_DRIVER, path: env.CACHE_PATH, prefix: env.CACHE_PREFIX }),
});
export type CacheConfig = ConfigOf<typeof CacheConfig>;

/** Registers the `Cache` (`CACHE_DRIVER`) and the `RateLimiter`. Found by `bespoke discover`. */
export class CacheServiceProvider implements ServiceProvider {
  static config = [CacheConfig];

  register(container: Container): void {
    const config = container.make(CacheConfig);
    container.singleton(Cache, (c) => {
      if (config.driver === 'memory') return new StoreCache(new MemoryStore(), config.prefix);
      const { root } = c.make(Application);
      return new StoreCache(new FileStore(isAbsolute(config.path) ? config.path : join(root, config.path)), config.prefix);
    });
    container.singleton(RateLimiter);
  }

  /** Live validations (E62) are limited on every route — in the global stack, before anything else runs for them. */
  boot(app: Application): void {
    if (app.container.has(Router)) app.container.make(Router).middleware.append(GLOBAL, LimitLiveValidation, MiddlewarePriority.limitLiveValidation);
  }
}
