import { randomUUID } from 'node:crypto';
import type { HealthCheck } from '@bespokecore/core';
import { Cache } from './cache.ts';
import { CacheConfig } from './config.ts';

/**
 * Readiness (E126): the cache takes a key and lets it go again — `add` + `forget` through the store of `CACHE_DRIVER`, so on
 * the infrastructure connection a database store writes through (E108). Registered by the `CacheServiceProvider` for `/up/ready`.
 */
export class CacheHealthCheck implements HealthCheck {
  static check = 'cache';

  readonly #cache: Cache;
  readonly #config: CacheConfig;

  constructor(cache: Cache, config: CacheConfig) {
    this.#cache = cache;
    this.#config = config;
  }

  async handle(): Promise<string> {
    const key = `health:${randomUUID()}`;
    if (!(await this.#cache.add(key, 1, 60))) throw new Error(`The cache did not take a new key (${key}).`);
    await this.#cache.forget(key);
    return this.#config.driver;
  }
}
