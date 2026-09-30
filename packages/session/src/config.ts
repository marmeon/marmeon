import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

const BOOLEAN = v.pipe(
  v.picklist(['true', 'false']),
  v.transform((value) => value === 'true'),
);

export const SessionConfig = defineConfig('session', {
  env: v.object({
    /** `file` survives restarts (default), `memory` is for tests, `cookie` keeps the data in the (encrypted) cookie. */
    SESSION_DRIVER: v.optional(v.picklist(['file', 'memory', 'cookie']), 'file'),
    /** Minutes of inactivity until the session expires. */
    SESSION_LIFETIME: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)), '120'),
    SESSION_COOKIE: v.optional(v.pipe(v.string(), v.regex(/^[\w-]+$/)), 'bespoke_session'),
    /** Where the `file` driver keeps sessions, relative to the app root. */
    SESSION_FILES: v.optional(v.string(), 'storage/framework/sessions'),
    /** Send the cookie over HTTPS only. Turn on in production. */
    SESSION_SECURE_COOKIE: v.optional(BOOLEAN, 'false'),
    SESSION_SAME_SITE: v.optional(v.picklist(['lax', 'strict', 'none']), 'lax'),
  }),
  resolve: (env) => ({
    driver: env.SESSION_DRIVER,
    lifetime: env.SESSION_LIFETIME,
    cookie: env.SESSION_COOKIE,
    files: env.SESSION_FILES,
    secure: env.SESSION_SECURE_COOKIE,
    sameSite: env.SESSION_SAME_SITE,
  }),
});
export type SessionConfig = ConfigOf<typeof SessionConfig>;
