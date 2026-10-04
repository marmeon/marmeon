import { defineConfig, environment, type ConfigOf } from '@bespokecore/core';
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
    /**
     * Send the session's cookies — and every other cookie the app sets without saying (E162) — over HTTPS only. Unset (or
     * empty): follows `APP_URL` — `https://…` → on, `http://…` → off. `true`/`false` decide it themselves.
     */
    SESSION_SECURE_COOKIE: v.optional(v.union([v.literal(''), BOOLEAN]), ''),
    /** The app's address — `https:` turns `SESSION_SECURE_COOKIE` on unless it is set. */
    APP_URL: v.optional(v.string()),
    NODE_ENV: v.optional(v.string()),
    SESSION_SAME_SITE: v.optional(v.picklist(['lax', 'strict', 'none']), 'lax'),
    /**
     * Encrypt the session data in its store (E144) — the file, the `payload` column, the Redis value — with the app's key
     * (`APP_KEY`; `APP_PREVIOUS_KEYS` still decrypt), bound to the session. Off by default (like Laravel); the store's keys are
     * hashes of the session ids either way. Turning it on or off signs everybody out once. The `cookie` driver's data is always
     * encrypted (it is a cookie).
     */
    SESSION_ENCRYPT: v.optional(BOOLEAN, 'false'),
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
    /** Where `secure` comes from: `SESSION_SECURE_COOKIE`, or `APP_URL`'s protocol (E162). */
    secureFrom: (env.SESSION_SECURE_COOKIE === '' ? 'APP_URL' : 'SESSION_SECURE_COOKIE') as 'APP_URL' | 'SESSION_SECURE_COOKIE',
    /** Protected environment (E139: not development, not test) — cookies without `Secure` there are warned about at boot. */
    protected: environment.isProtected(env),
    connection: env.SESSION_CONNECTION,
    lifetime: env.SESSION_LIFETIME,
    cookie: env.SESSION_COOKIE,
    files: env.SESSION_FILES,
    secure: env.SESSION_SECURE_COOKIE === '' ? isHttps(env.APP_URL) : env.SESSION_SECURE_COOKIE,
    sameSite: env.SESSION_SAME_SITE,
    encrypt: env.SESSION_ENCRYPT,
    lottery: env.SESSION_LOTTERY,
  }),
});
export type SessionConfig = ConfigOf<typeof SessionConfig>;

/** `APP_URL` names an HTTPS address. A broken URL counts as not (the app's own config reports it). */
function isHttps(url: string | undefined): boolean {
  try {
    return url !== undefined && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The boot warning of a protected environment (E139) whose cookies go without `Secure` (E162): over plain HTTP a session cookie
 * can be read and replayed by anybody on the way.
 */
export function insecureCookieWarning(from: 'APP_URL' | 'SESSION_SECURE_COOKIE'): string {
  return from === 'APP_URL'
    ? 'Cookies are sent without Secure: APP_URL is not https:// — the session cookie travels in plain text. Serve the app over HTTPS and set APP_URL=https://…'
    : 'Cookies are sent without Secure: SESSION_SECURE_COOKIE=false — the session cookie may travel in plain text. Remove it (it follows APP_URL) or set it to true.';
}
