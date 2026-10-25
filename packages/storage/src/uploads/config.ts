import { defineConfig, env, type ConfigOf } from '@marmeon/core';

const MEGABYTE = 1024 * 1024;

/** Temporary uploads: where their files wait, which connection their table is on, how long a token works. */
export const UploadsConfig = defineConfig('uploads', {
  env: env({
    /** The private disk the files wait on until a form stores them (default `uploads`; never a public disk — a startup error). */
    UPLOADS_DISK: env.string().default('uploads'),
    /**
     * The database connection of `temporary_uploads` (`marmeon make:uploads-table`). Infrastructure like the cache and sessions:
     * it never joins the app's transactions — on Postgres a small pool of its own; on SQLite name a connection with a
     * file of its own here (`system`), or a token cannot be used inside a transaction.
     */
    UPLOADS_CONNECTION: env.string().default('default'),
    /** Minutes a token works after its target was handed out (default 120, at most a day) — a form may stay open a while. */
    UPLOADS_LIFETIME_MINUTES: env.integer().min(1).max(1440, 'At most a day (1440): uploads:prune deletes uploads older than that.').default(120),
    /** Minutes the browser has to send the file to its target (default 15). */
    UPLOADS_SEND_WITHIN_MINUTES: env.integer().min(1).default(15),
    /** Open uploads (not used, token still works) one session may hold (default 20); another target is refused with a 429 until one is used or expires. */
    UPLOADS_MAX_OPEN: env.integer().min(1).default(20),
    /** Megabytes the open uploads of one session may announce together (default 1024). */
    UPLOADS_MAX_OPEN_MB: env.integer().min(1).default(1024),
    /** Megabytes the open uploads of all sessions may announce together (default 10240; 0 = no limit) — what keeps guests from filling the disk. */
    UPLOADS_MAX_OPEN_TOTAL_MB: env.integer().min(0).default(10240),
  })
    .renamed('UPLOADS_LIFETIME', 'UPLOADS_LIFETIME_MINUTES')
    .renamed('UPLOADS_SEND_WITHIN', 'UPLOADS_SEND_WITHIN_MINUTES'),
  resolve: (e) => ({
    disk: e.UPLOADS_DISK,
    connection: e.UPLOADS_CONNECTION,
    lifetimeMinutes: e.UPLOADS_LIFETIME_MINUTES,
    sendWithinMinutes: e.UPLOADS_SEND_WITHIN_MINUTES,
    maxOpen: e.UPLOADS_MAX_OPEN,
    maxOpenBytes: e.UPLOADS_MAX_OPEN_MB * MEGABYTE,
    maxOpenTotalBytes: e.UPLOADS_MAX_OPEN_TOTAL_MB * MEGABYTE,
  }),
});
export type UploadsConfig = ConfigOf<typeof UploadsConfig>;
