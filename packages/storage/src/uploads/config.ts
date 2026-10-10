import { defineConfig, env, type ConfigOf } from '@marmeon/core';

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
    UPLOADS_LIFETIME: env.integer().min(1).max(1440, 'At most a day (1440): uploads:prune deletes uploads older than that.').default(120),
    /** Minutes the browser has to send the file to its target (default 15). */
    UPLOADS_SEND_WITHIN: env.integer().min(1).default(15),
  }),
  resolve: (e) => ({ disk: e.UPLOADS_DISK, connection: e.UPLOADS_CONNECTION, lifetime: e.UPLOADS_LIFETIME, sendWithin: e.UPLOADS_SEND_WITHIN }),
});
export type UploadsConfig = ConfigOf<typeof UploadsConfig>;
