import { Container, defineConfig, resolveConfig } from '@bespokecore/core';
import { Database } from '@bespokecore/database';
import { abort, Controller, SharedData, type HttpContext } from '@bespokecore/http';
import { Router } from '@bespokecore/router';
import * as v from 'valibot';
import { LabConfig } from '../config.ts';
import { CheckoutService, LabReport, Money, Orders, ReminderSchedule } from '../errors.ts';

/** The lab's pages, each one view: a 404 unless the lab is on (`LabConfig`). */
export abstract class LabController extends Controller {
  protected readonly config: LabConfig;

  constructor(config: LabConfig) {
    super();
    this.config = config;
  }

  protected enabled(): void {
    if (!this.config.enabled) abort(404);
  }
}

/** A page with a slow Suspense boundary: the shell is sent at once, the slow part streams in after `LAB_DELAY` ms. */
export class ShowStreamingLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/Streaming', { slow: { delay: this.config.delay, text: `Rendered ${this.config.delay} ms after the shell.` }, now: new Date() });
  }
}

/** A page that reads `window` while rendering: server rendering fails, the browser renders it (client fallback). */
export class ShowClientOnlyLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/ClientOnly', { now: new Date() });
  }
}

/** A page that opts out of server rendering (`BrowserOnly.ssr = false`) — the right way to do what ClientOnly does. */
export class ShowBrowserOnlyLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/BrowserOnly', {});
  }
}

/** A page whose Suspense boundary fails on the server after the shell was sent: the browser renders that boundary. */
export class ShowLateErrorLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/LateError', { late: { delay: Math.min(this.config.delay, 300) } });
  }
}

/** What `/lab/errors/:kind` can make go wrong — each with the solution the development error page shows (E119, E130). */
export const ERROR_KINDS = {
  'container-unbound': 'A service needs an interface nobody bound',
  'container-scoped': 'A per-request service resolved outside a request',
  'container-no-list': 'A constructor parameter the container cannot inject (a number)',
  'container-circular': 'Two services that need each other',
  'injection-import-type': 'A constructor parameter whose type is imported with "import type"',
  'optional-parameter': 'A defaulted parameter of an injectable type (a warning, E128) — then an error',
  config: 'Invalid configuration (a variable missing)',
  'app-key': 'A missing APP_KEY',
  route: 'A route name that is not defined',
  table: 'A table that does not exist',
  view: 'A page whose view does not exist (server rendering fails: Vite\'s overlay)',
} as const;
export type ErrorKind = keyof typeof ERROR_KINDS;

/** The lab's list of errors to trigger. */
export class ShowErrorsLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/Errors', { kinds: Object.entries(ERROR_KINDS).map(([kind, label]) => ({ kind, label })) });
  }
}

/** Fails on purpose, the way `kind` says — the development error page shows the error and its solution. */
export class TriggerErrorLabController extends LabController {
  readonly #container: Container;
  readonly #router: Router;
  readonly #db: Database;

  constructor(config: LabConfig, container: Container, router: Router, db: Database) {
    super(config);
    this.#container = container;
    this.#router = router;
    this.#db = db;
  }

  async handle(ctx: HttpContext<{}, { kind: string }>) {
    this.enabled();
    const container = this.#container;
    switch (ctx.params.kind as ErrorKind) {
      case 'container-unbound':
        return container.make(CheckoutService);
      case 'container-scoped':
        // The app's container, not the request's scope: shared props live per request.
        return container.make(SharedData);
      case 'container-no-list':
        return container.make(Money);
      case 'container-circular':
        return container.make(Orders as never);
      case 'injection-import-type':
        return container.make(LabReport);
      case 'optional-parameter':
        container.make(ReminderSchedule);
        throw new Error('ReminderSchedule was built with its own SystemClock — see the injection warning below.');
      case 'config':
        return resolveConfig([defineConfig('payments', { env: v.object({ PAYMENTS_API_URL: v.pipe(v.string(), v.url()) }), resolve: (env) => env })], {});
      case 'app-key':
        // As the start checks it (@bespokecore/encryption's configuration) — here with an empty key.
        return resolveConfig([defineConfig('encryption', { env: v.object({ APP_KEY: v.pipe(v.string(), v.nonEmpty('Missing — run "bespoke key:generate"')) }), resolve: (env) => env })], { APP_KEY: '' });
      case 'route':
        return (this.#router.url as (this: Router, name: string) => string).call(this.#router, 'user-profile.shwo');
      case 'table':
        return this.#db.selectFrom('payments' as never).selectAll().execute();
      case 'view':
        return this.view('lab/Missing' as never, {});
      default:
        abort(404);
    }
  }
}
