import { Application, environment } from '@marmeon/core';
import { createHttpKernel, ServerConfig } from '@marmeon/server';
import type { AppCheck, AppCheckContext, AppCheckResult } from './registry.ts';
import type { CheckProblem } from './report.ts';

/** The path of the probe: under `/_marmeon/`, which no route of an app can take. */
const PROBE_PATH = '/_marmeon/hsts-probe';

/** What a browser makes of a `Strict-Transport-Security` header: its `max-age` in seconds, or `undefined` when it would ignore the header. */
export function maxAgeOf(header: string): number | undefined {
  // Headers of the same name arrive joined by a comma, and a browser acts on the first one only.
  const first = header.split(',')[0] ?? '';
  const values: string[] = [];
  for (const directive of first.split(';')) {
    const [name = '', ...rest] = directive.split('=');
    if (name.trim().toLowerCase() === 'max-age') values.push(rest.join('=').trim().replace(/^"(.*)"$/, '$1'));
  }
  // A directive given twice makes the header invalid, and browsers ignore it.
  return values.length === 1 && /^\d+$/.test(values[0]!) ? Number(values[0]) : undefined;
}

const HOW = 'Turn it on with securityHeaders({ hsts: … }) in bootstrap/app.ts once the site answers over HTTPS only. If your proxy sets it, leave this check out there: --skip=hsts.';

/**
 * Warns when the app, running as production on an `https` `APP_URL`, sends no `Strict-Transport-Security` (or one that turns
 * HSTS off) on HTTPS responses. It runs the app's code, so it asks once and little: one GET of a path under `/_marmeon/` that
 * no route of the app can take, from the loopback address, without cookies or body. A proxy that sets the header itself makes
 * the warning a false one: leave the check out there with `--skip=hsts`. See docs/check.md#hsts.
 */
export class HstsCheck implements AppCheck {
  static check = 'hsts';
  static phase = 'run' as const;

  readonly #app: Application;
  readonly #config: ServerConfig;

  constructor(app: Application, config: ServerConfig) {
    this.#app = app;
    this.#config = config;
  }

  async handle(context?: AppCheckContext): Promise<AppCheckResult> {
    if (environment.isDevelopment() || environment.isTest()) {
      return { skipped: 'only checked when the app runs as production — run it with NODE_ENV=production and your production environment: marmeon check --only=boot,hsts' };
    }
    const appUrl = this.#config.appUrl;
    if (!appUrl || !URL.canParse(appUrl) || new URL(appUrl).protocol !== 'https:') {
      return { skipped: 'APP_URL is not an https URL — the check needs NODE_ENV=production and an https APP_URL: marmeon check --only=boot,hsts' };
    }
    const kernel = createHttpKernel(this.#app);
    const response = await kernel.fetch(new Request(new URL(PROBE_PATH, appUrl), { headers: { accept: 'application/json' }, ...(context ? { signal: context.signal } : {}) }), { remoteAddress: '127.0.0.1' });
    await response.body?.cancel();
    await kernel.settle();
    const header = response.headers.get('strict-transport-security');
    const warn = (message: string): CheckProblem[] => [{ severity: 'warning', message: `${message} ${HOW}`, rule: 'marmeon(hsts)', docs: 'docs/security.md#strict-transport-security' }];
    if (header === null) return warn('Responses over HTTPS carry no Strict-Transport-Security header.');
    const maxAge = maxAgeOf(header);
    if (maxAge === undefined) return warn('The Strict-Transport-Security header has no valid max-age, so browsers ignore it.');
    if (maxAge === 0) return warn('The Strict-Transport-Security header has max-age=0, which turns HSTS off.');
    return [];
  }
}
