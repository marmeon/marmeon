import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

/** Exactly `true` or `false`. */
const BOOLEAN = env.in(['true', 'false']);

export const SessionConfig = defineConfig('session', {
  env: env({
    /**
     * `file` (default: one machine, survives restarts), `database` (the app's database — `marmeon make:session-table`
     * writes the migration), `redis` (needs @marmeon/redis and redis), or `memory` (tests).
     */
    SESSION_DRIVER: env.in(['file', 'database', 'redis', 'memory']).default('file'),
    /**
     * Which database or Redis connection the `database`/`redis` driver uses. The database driver never joins the app's
     * transactions: on Postgres it opens a small pool of its own; on SQLite name a connection with a file of its
     * own here, or sessions cannot be written inside a transaction.
     */
    SESSION_CONNECTION: env.string().default('default'),
    /** Minutes of inactivity until the session expires. */
    SESSION_LIFETIME: env.integer().min(1).default(120),
    SESSION_COOKIE: env.string().regex(/^[\w-]+$/).default('marmeon_session'),
    /** Where the `file` driver keeps sessions, relative to the app root. */
    SESSION_FILES: env.string().default('storage/framework/sessions'),
    /**
     * Send the session's cookies — and every other cookie the app sets without saying — over HTTPS only. Unset (or
     * empty): follows `APP_URL` — `https://…` → on, `http://…` → off. `true`/`false` decide it themselves.
     */
    SESSION_SECURE_COOKIE: BOOLEAN.optional(),
    /** The app's address — `https:` turns `SESSION_SECURE_COOKIE` on unless it is set. */
    APP_URL: env.string().optional(),
    NODE_ENV: env.string().optional(),
    SESSION_SAME_SITE: env.in(['lax', 'strict', 'none']).default('lax'),
    /**
     * Encrypt the session data in its store — the file, the `payload` column, the Redis value — with the app's key
     * (`APP_KEY`; `APP_PREVIOUS_KEYS` still decrypt), bound to the session. Off by default; the store's keys are
     * hashes of the session ids either way. Turning it on or off signs everybody out once.
     */
    SESSION_ENCRYPT: BOOLEAN.default('false'),
    /**
     * Chance that a request also cleans up expired sessions, after the response. `0/1` turns it off —
     * for apps that run `marmeon session:prune` from a scheduler or cron instead.
     */
    SESSION_LOTTERY: env.string().regex(/^\d+\/[1-9]\d*$/, 'Expected a chance like 2/100').default('2/100'),
  }),
  resolve: (e) => ({
    driver: e.SESSION_DRIVER,
    /** Where `secure` comes from: `SESSION_SECURE_COOKIE`, or `APP_URL`'s protocol. */
    secureFrom: (e.SESSION_SECURE_COOKIE === undefined ? 'APP_URL' : 'SESSION_SECURE_COOKIE') as 'APP_URL' | 'SESSION_SECURE_COOKIE',
    /** Protected environment (not development, not test) — cookies without `Secure` there are warned about at boot. */
    protected: environment.isProtected(e),
    connection: e.SESSION_CONNECTION,
    lifetime: e.SESSION_LIFETIME,
    cookie: e.SESSION_COOKIE,
    files: e.SESSION_FILES,
    secure: e.SESSION_SECURE_COOKIE === undefined ? isHttps(e.APP_URL) : e.SESSION_SECURE_COOKIE === 'true',
    sameSite: e.SESSION_SAME_SITE,
    encrypt: e.SESSION_ENCRYPT === 'true',
    lottery: chance(e.SESSION_LOTTERY),
  }),
});
export type SessionConfig = ConfigOf<typeof SessionConfig>;

/** `2/100` → 0.02. */
function chance(lottery: string): number {
  const [hits, draws] = lottery.split('/').map(Number) as [number, number];
  return hits / draws;
}

/** `APP_URL` names an HTTPS address. A broken URL counts as not (the app's own config reports it). */
function isHttps(url: string | undefined): boolean {
  try {
    return url !== undefined && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The boot warning of a protected environment whose cookies go without `Secure`: over plain HTTP a session cookie
 * can be read and replayed by anybody on the way.
 */
export function insecureCookieWarning(from: 'APP_URL' | 'SESSION_SECURE_COOKIE'): string {
  return from === 'APP_URL'
    ? 'Cookies are sent without Secure: APP_URL is not https:// — the session cookie travels in plain text. Serve the app over HTTPS and set APP_URL=https://…'
    : 'Cookies are sent without Secure: SESSION_SECURE_COOKIE=false — the session cookie may travel in plain text. Remove it (it follows APP_URL) or set it to true.';
}
