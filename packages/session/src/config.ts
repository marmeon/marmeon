import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

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
    SESSION_LIFETIME_MINUTES: env.integer().min(1).default(120),
    SESSION_COOKIE: env.string().regex(/^(?!__(host|secure)-)[\w-]+$/i, 'Expected letters, digits, _ and -, without a __Host- or __Secure- prefix: the framework adds __Host- itself').default('marmeon_session'),
    /** Where the `file` driver keeps sessions, relative to the app root. */
    SESSION_FILES: env.string().default('storage/framework/sessions'),
    /**
     * Send the session's cookies — and every other cookie the app sets without saying — over HTTPS only. Unset (or
     * empty): follows `APP_URL` — `https://…` → on, `http://…` → off. `true`/`false` (or `1`/`0`) decide it themselves.
     */
    SESSION_SECURE_COOKIE: env.boolean().optional(),
    /** The app's address — `https:` turns `SESSION_SECURE_COOKIE` on unless it is set. */
    APP_URL: env.string().optional(),
    NODE_ENV: env.string().optional(),
    SESSION_SAME_SITE: env.in(['lax', 'strict', 'none']).default('lax'),
    /**
     * Encrypt the session data in its store — the file, the `payload` column, the Redis value — with the app's key
     * (`APP_KEY`; `APP_PREVIOUS_KEYS` still decrypt), bound to the session. Off by default; the store's keys are
     * hashes of the session ids either way. Turning it on or off signs everybody out once.
     */
    SESSION_ENCRYPT: env.boolean().default(false),
    /**
     * Chance that a request also cleans up expired sessions, after the response. `0/1` turns it off —
     * for apps that run `marmeon session:prune` from a scheduler or cron instead.
     */
    SESSION_LOTTERY: env.string().regex(/^\d+\/[1-9]\d*$/, 'Expected a chance like 2/100').default('2/100'),
  })
    .renamed('SESSION_LIFETIME', 'SESSION_LIFETIME_MINUTES'),
  resolve: (e) => refuseOldKeys({
    driver: e.SESSION_DRIVER,
    /** Where `secure` comes from: `SESSION_SECURE_COOKIE`, or `APP_URL`'s protocol. */
    secureFrom: (e.SESSION_SECURE_COOKIE === undefined ? 'APP_URL' : 'SESSION_SECURE_COOKIE') as 'APP_URL' | 'SESSION_SECURE_COOKIE',
    /** Protected environment (not development, not test) — cookies without `Secure` there are warned about at boot. */
    protected: environment.isProtected(e),
    connection: e.SESSION_CONNECTION,
    lifetimeMinutes: e.SESSION_LIFETIME_MINUTES,
    cookie: e.SESSION_COOKIE,
    files: e.SESSION_FILES,
    secure: e.SESSION_SECURE_COOKIE === undefined ? isHttps(e.APP_URL) : e.SESSION_SECURE_COOKIE,
    sameSite: e.SESSION_SAME_SITE,
    encrypt: e.SESSION_ENCRYPT,
    lottery: chance(e.SESSION_LOTTERY),
  }),
});
export type SessionConfig = ConfigOf<typeof SessionConfig>;

const RENAMED_KEYS: Readonly<Record<string, string>> = { lifetime: 'lifetimeMinutes' };

/** The keys of the SessionConfig that changed their name: an untyped read of one throws instead of answering `undefined`. */
function refuseOldKeys<T extends object>(config: T): T {
  for (const [old, now] of Object.entries(RENAMED_KEYS)) {
    Object.defineProperty(config, old, {
      enumerable: false,
      get() {
        throw new TypeError(`SessionConfig.${old} was renamed SessionConfig.${now} — the value is the same number, now with its unit in the name.`);
      },
    });
  }
  return config;
}

/**
 * The name the session cookie goes by: `SESSION_COOKIE`, with the `__Host-` prefix when cookies are `Secure`. Over plain HTTP
 * (development) there is no prefix — a browser would refuse it. Only this name is ever read; see `docs/session.md#the-__host--prefix`.
 */
export function sessionCookieName(config: Pick<SessionConfig, 'cookie' | 'secure'>): string {
  return config.secure ? `__Host-${config.cookie}` : config.cookie;
}

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
