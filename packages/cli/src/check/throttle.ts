import { Application, Redactor } from '@marmeon/core';
import { Router, type AnyMiddleware } from '@marmeon/router';
import { ensuresOf, isEveryone, routeAccess } from '@marmeon/router/internal';
import type { AppCheck, AppCheckResult } from './registry.ts';
import type { CheckProblem } from './report.ts';
import { placeOf } from './route-types.ts';
import { silence } from './silence.ts';

/** The methods that read: a route that answers only these changes nothing. */
const READING = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Warns at every route that changes something, that anyone may call without signing in, and that nothing limits: no middleware
 * of the route, its group or the app declares that it authenticates or limits (`static ensures`). Reads the registered routes
 * only; the app is not booted. See docs/check.md#routes-without-a-limit.
 */
export class ThrottleCheck implements AppCheck {
  static check = 'throttle';
  static phase = 'build' as const;

  readonly #router: Router;
  readonly #app: Application;

  constructor(router: Router, app: Application) {
    this.#router = router;
    this.#app = app;
  }

  handle(): AppCheckResult {
    const redactor = this.#app.container.has(Redactor) ? this.#app.container.make(Redactor) : new Redactor();
    const found: CheckProblem[] = [];
    // `HttpServiceProvider.boot()` appends these to the router's groups; this check runs before any boot, so it reads them from the definition.
    const defined = (this.#app.definition as { middleware?: Partial<Record<string, readonly AnyMiddleware[]>> }).middleware ?? {};
    for (const route of this.#router.routes) {
      if (this.#router.isFrameworkRoute(route)) continue;
      const checks = routeAccess(route);
      // A route that does not say who may call it is `route-types`' finding (`H3`), not this check's.
      if (checks.length === 0 || !checks.every(isEveryone)) continue;
      const changing = route.methods.filter((method) => !READING.has(method));
      if (changing.length === 0) continue;
      const inGroup = route.group === 'web' || route.group === 'api' ? (defined[route.group] ?? []) : [];
      if ([...this.#router.middlewareFor(route), ...(defined.global ?? []), ...inGroup].some((middleware) => ensuresOf(middleware).length > 0)) continue;
      const which = `${changing.join('|')} ${redactor.path(route.path, route.path)}${route.routeName ? ` (${route.routeName})` : ''}`;
      found.push({
        severity: 'warning',
        message:
          `${which} can be called by anyone and nothing limits it — add \`throttle('<name>')\` (or \`authenticate()\`), or silence this with ` +
          '`// marmeon-check-ignore throttle: <why it needs no limit>`',
        ...placeOf(route.site, this.#app.root),
        rule: 'marmeon(throttle)',
        docs: 'docs/rate-limiting.md#applying-limits-to-routes',
      });
    }
    return silence('throttle', this.#app.root, found);
  }
}
