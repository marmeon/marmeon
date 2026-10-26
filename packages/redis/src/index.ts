import { Application, defineConfig, env, Logger, Redactor, type ConfigDefinition, type ConfigOf, type Container, type InferOutput, type ServiceProvider, type StandardSchemaV1 } from '@marmeon/core';
import { RedisConnections, type RedisConnectionOptions } from './connections.ts';
import { RedisHealthCheck } from './health.ts';

// Redis connections on node-redis, opened per name on first use: the cache, session, queue and live drivers build on them.
export { defineRedisScript, RedisConnection, RedisConnections } from './connections.ts';
export type { RedisConnectionOptions, RedisScript } from './connections.ts';
export { RedisHealthCheck } from './health.ts';

/** `My App` → `my-app:`; undefined when the name has no letter or digit to make a slug of. */
function prefixOf(name: string | undefined): string | undefined {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? undefined : `${slug}:`;
}

/** An explicit `REDIS_PREFIX`, else the app's name as a slug. There is no default: two apps on one Redis must never share a key. */
const prefixFrom = (e: { REDIS_PREFIX: string | undefined; APP_NAME: string | undefined }): string | undefined => e.REDIS_PREFIX ?? prefixOf(e.APP_NAME);

/**
 * The default connection, from the environment:
 *
 * ```sh
 * REDIS_URL=redis://127.0.0.1:6379      # redis://[[user]:password@]host[:port][/db], rediss:// for TLS
 * REDIS_PREFIX=myapp:                   # else APP_NAME as a slug, plus ":"; with neither the app does not start
 * ```
 *
 * See `docs/redis.md#configuration`.
 */
export const RedisConfig = defineConfig('redis', {
  env: env({
    REDIS_URL: env.url({ protocols: ['redis', 'rediss'], message: 'Expected a redis:// or rediss:// URL' }).default('redis://127.0.0.1:6379'),
    REDIS_PREFIX: env.string().optional(),
    APP_NAME: env.string().optional(),
  }).check(
    (e) => prefixFrom(e) !== undefined,
    'set REDIS_PREFIX, or APP_NAME (with a letter or digit) — apps on one Redis share their keys otherwise (docs/redis.md#configuration)',
    'REDIS_PREFIX',
  ),
  resolve: (e): { default: RedisConnectionOptions } => ({ default: { url: e.REDIS_URL, prefix: prefixFrom(e)! } }),
});
export type RedisConfig = ConfigOf<typeof RedisConfig>;

/** A named Redis connection besides the default: a config definition that knows its name. */
export interface RedisConnectionDefinition extends ConfigDefinition<RedisConnectionOptions> {
  readonly redisConnection: string;
}

/**
 * Another Redis connection, e.g. a separate instance for the queue: list it in the app's (or a module's) `config` and get it
 * with `redis.get(name)`. Throws for the name `default`; a `resolve` that returns an empty prefix stops the start. `resolve`
 * also runs while the variables are checked, so keep it free of side effects. See `docs/redis.md#more-connections`.
 */
export function defineRedisConnection<const Schema extends StandardSchemaV1>(
  name: string,
  definition: { env: Schema; resolve: (env: InferOutput<Schema>) => RedisConnectionOptions },
): RedisConnectionDefinition {
  if (name === 'default') throw new TypeError('"default" is the connection from REDIS_URL; give this one another name.');
  // The empty prefix is an issue of the env schema, so it lands in the start's list of problems (and, in the build phase,
  // makes the connection unavailable) like any other invalid setting.
  const inner = definition.env['~standard'];
  const checked: StandardSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: inner.vendor,
      validate: async (value, options) => {
        const result = await inner.validate(value, options);
        if (result.issues || definition.resolve(result.value as InferOutput<Schema>).prefix !== '') return result;
        return { issues: [{ message: `the prefix is empty — set one in its resolve, e.g. 'myapp:' — apps on one Redis share their keys otherwise (docs/redis.md#more-connections)` }] };
      },
    },
  };
  return Object.freeze({ ...defineConfig(`redis.${name}`, { env: checked, resolve: definition.resolve as (env: unknown) => RedisConnectionOptions }), redisConnection: name });
}

function isRedisConnectionDefinition(value: unknown): value is RedisConnectionDefinition {
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
      const named = [...(app.definition.config ?? []), ...app.modules.flatMap((module) => module.config ?? [])].filter(isRedisConnectionDefinition);
      const connections: Record<string, RedisConnectionOptions> = { default: c.make(RedisConfig).default };
      for (const definition of named) connections[definition.redisConnection] = c.make(definition);
      return new RedisConnections({ connections, logger: c.make(Logger), redactor: c.make(Redactor) });
    });
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(RedisConnections).close();
  }
}
