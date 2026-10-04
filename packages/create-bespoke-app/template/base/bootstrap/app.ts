import { join } from 'node:path';
import { defineApplication } from '@bespokecore/core';
import { contentSecurityPolicy } from '@bespokecore/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';
import { SecurityHeaders } from '../middleware/SecurityHeaders.ts';

/** A new app: only `system` (the queue's tables, `bespoke make:queue-table`). `bespoke make:auth` adds the auth module here. */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  // Every response: the security headers (HSTS when you turn it on); every document: a strict Content-Security-Policy with a
  // nonce per response (E147) — add directives for what your pages load from elsewhere.
  middleware: {
    global: [SecurityHeaders, contentSecurityPolicy()],
  },
});
