import { Application, defineConfig, env, Logger, Redactor, type ConfigDefinition, type ConfigOf, type Container, type InferOutput, type ServiceProvider, type StandardSchemaV1 } from '@marmeon/core';
import { RedisConnections, type RedisConnectionOptions } from './connections.ts';
import { RedisHealthCheck } from './health.ts';

// Redis connections on node-redis, opened per name on first use: the cache, session, queue and live drivers build on them.
export { defineRedisScript, describeRedisUrl, RedisConnection, RedisConnections } from './connections.ts';
export type { RedisConnectionOptions, RedisScript } from './connections.ts';
export { RedisHealthCheck } from './health.ts';

/** `My App` → `my-app:` — the default prefix, so two apps on one Redis never share a key. */
function prefixOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'marmeon'}:`;
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
  env: env({
    REDIS_URL: env.url({ protocols: ['redis', 'rediss'], message: 'Expected a redis:// or rediss:// URL' }).default('redis://127.0.0.1:6379'),
    REDIS_PREFIX: env.string().optional(),
    APP_NAME: env.string().default('marmeon'),
  }),
  resolve: (e): { default: RedisConnectionOptions } => ({ default: { url: e.REDIS_URL, prefix: e.REDIS_PREFIX ?? prefixOf(e.APP_NAME) } }),
});
export type RedisConfig = ConfigOf<typeof RedisConfig>;

/** A named Redis connection besides the default: a config definition that knows its name. */
export interface RedisConnectionDefinition extends ConfigDefinition<RedisConnectionOptions> {
  readonly redisConnection: string;
}

/**
 * Another Redis connection, e.g. a separate instance for the queue: list it in the app's (or a module's) `config` and get it
 * with `redis.get(name)`. Throws for the name `default`. See `docs/redis.md#more-connections`.
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

/** Registers `RedisConnections` and closes every connection on shutdown. Found by `marmeon discover`. */
export class RedisServiceProvider implements ServiceProvider {
  static config = [RedisConfig];
  /** The connections in use answer `PING`, for `/up/ready`. */
  static health = [RedisHealthCheck];

  register(container: Container): void {
    container.singleton(RedisConnections, (c) => {
      const app = c.make(Application);
      const named = [...(app.options.config ?? []), ...app.modules.flatMap((module) => module.config ?? [])].filter(isRedisConnectionDefinition);
      const connections: Record<string, RedisConnectionOptions> = { default: c.make(RedisConfig).default };
      for (const definition of named) connections[definition.redisConnection] = c.make(definition);
      return new RedisConnections({ connections, logger: c.make(Logger), redactor: c.make(Redactor) });
    });
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(RedisConnections).close();
  }
}
