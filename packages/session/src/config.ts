import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

const BOOLEAN = v.pipe(
  v.picklist(['true', 'false']),
  v.transform((value) => value === 'true'),
);

export const SessionConfig = defineConfig('session', {
  env: v.object({
    /**
     * `file` (default: one machine, survives restarts), `database` (the app's database — `bespoke make:session-table`
     * writes the migration), `redis` (needs @bespokecore/redis and redis), `memory` (tests) or `cookie` (the data in the
     * encrypted cookie — not for apps with sign-in, E46).
     */
    SESSION_DRIVER: v.optional(v.picklist(['file', 'database', 'redis', 'memory', 'cookie']), 'file'),
    /**
     * Which database or Redis connection the `database`/`redis` driver uses. The database driver never joins the app's
     * transactions (E108): on Postgres it opens a small pool of its own; on SQLite name a connection with a file of its
     * own here, or sessions cannot be written inside a transaction.
     */
    SESSION_CONNECTION: v.optional(v.string(), 'default'),
    /** Minutes of inactivity until the session expires. */
    SESSION_LIFETIME: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)), '120'),
    SESSION_COOKIE: v.optional(v.pipe(v.string(), v.regex(/^[\w-]+$/)), 'bespoke_session'),
    /** Where the `file` driver keeps sessions, relative to the app root. */
    SESSION_FILES: v.optional(v.string(), 'storage/framework/sessions'),
    /** Send the cookie over HTTPS only. Turn on in production. */
    SESSION_SECURE_COOKIE: v.optional(BOOLEAN, 'false'),
    SESSION_SAME_SITE: v.optional(v.picklist(['lax', 'strict', 'none']), 'lax'),
    /**
     * Chance that a request also cleans up expired sessions, after the response (Laravel's lottery). `0/1` turns it off —
     * for apps that run `bespoke session:prune` from a scheduler or cron instead.
     */
    SESSION_LOTTERY: v.optional(
      v.pipe(
        v.string(),
        v.regex(/^\d+\/[1-9]\d*$/, 'Expected a chance like 2/100'),
        v.transform((value) => {
          const [hits, draws] = value.split('/').map(Number) as [number, number];
          return hits / draws;
        }),
      ),
      '2/100',
    ),
  }),
  resolve: (env) => ({
    driver: env.SESSION_DRIVER,
    connection: env.SESSION_CONNECTION,
    lifetime: env.SESSION_LIFETIME,
    cookie: env.SESSION_COOKIE,
    files: env.SESSION_FILES,
    secure: env.SESSION_SECURE_COOKIE,
    sameSite: env.SESSION_SAME_SITE,
    lottery: env.SESSION_LOTTERY,
  }),
});
export type SessionConfig = ConfigOf<typeof SessionConfig>;
