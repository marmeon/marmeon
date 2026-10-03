import { HealthChecks, Redactor, type Application, type Container, type HealthReport } from '@bespokecore/core';
import { ServerClosing } from '@bespokecore/http';
import type { RouteDefinition } from '@bespokecore/router';

/**
 * The health endpoints (E126), answered by the kernel before anything else runs for a request — no request id, no session, no
 * CSRF, no middleware of any group, no log line, no `http.request` message (so neither a span nor a devtools entry):
 *
 * - `GET /up` — liveness: `200 OK` once the app booted, `503` from the moment the server closes (E102's drain). It checks
 *   nothing else — a database outage must not get a healthy process restarted.
 * - `GET /up/ready` — readiness: every `HealthCheck` (the packages' — database, redis, cache, queue — and the app's), at once,
 *   each with its time limit: `200 {"status":"ok"}`, else `503 {"status":"failing"}` (`"draining"` while the server closes).
 *   Which checks ran, how long they took and why one failed only with `NODE_ENV=development` (`ServerConfig.debug`).
 */
export interface HealthEndpoints {
  /** `/up` — or what `HEALTH_PATH` says. */
  readonly path: string;
  readonly readyPath: string;
  live(): Response;
  ready(): Promise<Response>;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** The endpoints for `application`, under `path`. `debug`: the details of each check in the answer. */
export function createHealthEndpoints(application: Application, container: Container, { path, debug }: { path: string; debug: boolean }): HealthEndpoints {
  const closing = container.has(ServerClosing) ? container.make(ServerClosing) : undefined;
  const checks = application.container.has(HealthChecks) ? application.container.make(HealthChecks) : new HealthChecks();
  const draining = () => closing?.signal.aborted === true;
  // Probes arrive from several places at once (load balancer, orchestrator): one run serves every request that comes while it runs.
  let running: Promise<HealthReport> | undefined;

  return {
    path,
    readyPath: `${path === '/' ? '' : path}/ready`,
    live: () =>
      draining()
        ? new Response('Service Unavailable', { status: 503, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } })
        : new Response('OK', { status: 200, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } }),
    ready: async () => {
      if (draining()) return Response.json({ status: 'draining' }, { status: 503, headers: NO_STORE });
      running ??= checks.run(container).finally(() => {
        running = undefined;
      });
      const report = await running;
      const status = report.ok ? 'ok' : 'failing';
      if (!debug) return Response.json({ status }, { status: report.ok ? 200 : 503, headers: NO_STORE });
      const redactor = application.container.has(Redactor) ? application.container.make(Redactor) : new Redactor();
      return Response.json(
        {
          status,
          checks: report.checks.map((check) => ({
            name: check.name,
            status: check.status,
            ms: check.ms,
            ...(check.note === undefined ? {} : { note: redactor.text(check.note) }),
            ...(check.error === undefined ? {} : { error: redactor.text(check.error instanceof Error ? check.error.message : String(check.error)) }),
          })),
        },
        { status: report.ok ? 200 : 503, headers: NO_STORE },
      );
    },
  };
}

/**
 * A route of the app on a health path would never be reached — the kernel answers there first. The start fails instead,
 * saying how to move one of them. (A route with a parameter, `/:page`, simply never sees `up`.)
 */
export function checkHealthPaths(health: HealthEndpoints, routes: readonly RouteDefinition[]): void {
  for (const route of routes) {
    if (route.path !== health.path && route.path !== health.readyPath) continue;
    const name = route.routeName === undefined ? '' : ` "${route.routeName}"`;
    throw new Error(
      `The route${name} (${route.methods.join('|')} ${route.path}) is where the health check answers (E126) — it would never be reached. ` +
        `Give the route another path, or move the health check: HEALTH_PATH=/healthz (or HEALTH_PATH=off).`,
    );
  }
}
