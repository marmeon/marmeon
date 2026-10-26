import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, securityHeaders } from '@marmeon/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';

/** The modules the app runs: `system` holds the queue's tables (`marmeon make:queue-table`); `marmeon make:auth` adds `auth` to the list. */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  // Every response: the security headers — once the site answers over HTTPS only, turn on HSTS with
  // `securityHeaders({ hsts: { maxAge: { days: 365 }, includeSubDomains: true } })`; every document: a strict Content-Security-Policy
  // with a nonce per response — add directives for what your pages load from elsewhere.
  middleware: {
    global: [securityHeaders(), contentSecurityPolicy()],
  },
});
