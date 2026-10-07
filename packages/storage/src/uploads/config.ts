import { defineConfig, type ConfigOf } from '@marmeon/core';
import * as v from 'valibot';

const MINUTES = v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1));

/** Temporary uploads (W6.9): where their files wait, which connection their table is on, how long a token works. */
export const UploadsConfig = defineConfig('uploads', {
  env: v.object({
    /** The private disk the files wait on until a form stores them (default `uploads`; never a public disk — a startup error). */
    UPLOADS_DISK: v.optional(v.string(), 'uploads'),
    /**
     * The database connection of `temporary_uploads` (`marmeon make:uploads-table`). Infrastructure like the cache and sessions
     * (E108): it never joins the app's transactions — on Postgres a small pool of its own; on SQLite name a connection with a
     * file of its own here (`system`), or a token cannot be used inside a transaction.
     */
    UPLOADS_CONNECTION: v.optional(v.string(), 'default'),
    /** Minutes a token works after its target was handed out (default 120, at most a day) — a form may stay open a while. */
    UPLOADS_LIFETIME: v.optional(v.pipe(MINUTES, v.maxValue(1440, 'At most a day (1440): uploads:prune deletes uploads older than that.')), '120'),
    /** Minutes the browser has to send the file to its target (default 15). */
    UPLOADS_SEND_WITHIN: v.optional(MINUTES, '15'),
  }),
  resolve: (env) => ({ disk: env.UPLOADS_DISK, connection: env.UPLOADS_CONNECTION, lifetime: env.UPLOADS_LIFETIME, sendWithin: env.UPLOADS_SEND_WITHIN }),
});
export type UploadsConfig = ConfigOf<typeof UploadsConfig>;
