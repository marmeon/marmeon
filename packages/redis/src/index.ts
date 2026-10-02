import { Application, defineConfig, Logger, type ConfigDefinition, type ConfigOf, type Container, type InferOutput, type ServiceProvider, type StandardSchemaV1 } from '@bespokecore/core';
import * as v from 'valibot';
import { RedisConnections, type RedisConnectionOptions } from './connections.ts';

// Redis (E87): connections like database connections — lazy per name, closed on shutdown — on the official client
// `redis` (node-redis), an optional peer. The cache, session, queue and live drivers build on it.
export { defineRedisScript, describeRedisUrl, loadRedisClient, REDIS_INSTALL, RedisConnection, RedisConnections, RedisSetupError } from './connections.ts';
export type { ImportRedisClient, RedisConnectionOptions, RedisScript } from './connections.ts';

const redisUrl = v.pipe(v.string(), v.regex(/^rediss?:\/\//, 'Expected a redis:// or rediss:// URL'), v.url());

/** `My App` → `my-app:` — the default prefix, so two apps on one Redis never share a key. */
function prefixOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'bespoke'}:`;
}

/**
 * The default connection, from the environment:
 *
 * ```sh
 * REDIS_URL=redis://127.0.0.1:6379      # redis://[[user]:password@]host[:port][/db], rediss:// for TLS
 * REDIS_PREFIX=myapp:                   # default: APP_NAME as a slug, plus ":"
 * ```
 */
export const RedisConfig = defineConfig('redis', {
  env: v.object({
    REDIS_URL: v.optional(redisUrl, 'redis://127.0.0.1:6379'),
    REDIS_PREFIX: v.optional(v.string()),
    APP_NAME: v.optional(v.string(), 'bespoke'),
  }),
  resolve: (env): { default: RedisConnectionOptions } => ({ default: { url: env.REDIS_URL, prefix: env.REDIS_PREFIX ?? prefixOf(env.APP_NAME) } }),
});
export type RedisConfig = ConfigOf<typeof RedisConfig>;

/** A named Redis connection besides the default: a config definition that knows its name. */
export interface RedisConnectionDefinition extends ConfigDefinition<RedisConnectionOptions> {
  readonly redisConnection: string;
}

/**
 * Another Redis connection, e.g. a separate instance for the queue. List it with the app's (or a module's) `config`;
 * its variables are validated at startup like all configuration:
 *
 * ```ts
 * export const QueueRedis = defineRedisConnection('queue', {
 *   env: v.object({ QUEUE_REDIS_URL: v.string() }),
 *   resolve: (env) => ({ url: env.QUEUE_REDIS_URL, prefix: 'myapp:' }),
 * });
 * defineApplication({ config: [QueueRedis], … });
 * redis.get('queue')
 * ```
 */
export function defineRedisConnection<const Schema extends StandardSchemaV1>(
  name: string,
  definition: { env: Schema; resolve: (env: InferOutput<Schema>) => RedisConnectionOptions },
): RedisConnectionDefinition {
  if (name === 'default') throw new TypeError('"default" is the connection from REDIS_URL; give this one another name.');
  return Object.freeze({ ...defineConfig(`redis.${name}`, definition), redisConnection: name });
}

export function isRedisConnectionDefinition(value: unknown): value is RedisConnectionDefinition {
  return typeof (value as Partial<RedisConnectionDefinition> | undefined)?.redisConnection === 'string';
}

/** Registers `RedisConnections` and closes every connection on shutdown. Found by `bespoke discover`. */
export class RedisServiceProvider implements ServiceProvider {
  static config = [RedisConfig];

  register(container: Container): void {
    container.singleton(RedisConnections, (c) => {
      const app = c.make(Application);
      const named = [...(app.options.config ?? []), ...app.modules.flatMap((module) => module.config ?? [])].filter(isRedisConnectionDefinition);
      const connections: Record<string, RedisConnectionOptions> = { default: c.make(RedisConfig).default };
      for (const definition of named) connections[definition.redisConnection] = c.make(definition);
      return new RedisConnections({ connections, logger: c.make(Logger) });
    });
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(RedisConnections).close();
  }
}
