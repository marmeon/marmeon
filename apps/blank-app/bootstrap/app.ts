import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, securityHeaders } from '@marmeon/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';

/** A new app: only `system` (the queue's tables, `marmeon make:queue-table`). `marmeon make:auth` adds the auth module here. */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  // Every response: the security headers — once the site answers over HTTPS only, turn on HSTS with
  // `securityHeaders({ hsts: { maxAge: 31_536_000, includeSubDomains: true } })`; every document: a strict Content-Security-Policy
  // with a nonce per response — add directives for what your pages load from elsewhere.
  middleware: {
    global: [securityHeaders(), contentSecurityPolicy()],
  },
});
