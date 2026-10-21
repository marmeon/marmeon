import { Clock, HealthChecks, Redactor, type Application, type Container, type HealthReport } from '@marmeon/core';
import { ServerClosing } from '@marmeon/http';
import type { RouteDefinition } from '@marmeon/router';

/**
 * The health endpoints, answered by the kernel before anything else runs for a request (no request id, session, CSRF,
 * middleware, log line or `http.request` message). `/up` is liveness and checks nothing else; `/up/ready` runs every
 * `HealthCheck`, answers 503 from the stop signal on, and keeps its result for {@link READY_CACHE_MS} (the path is public);
 * its details only with `NODE_ENV=development`. See docs/health.md#liveness-and-readiness.
 */
export interface HealthEndpoints {
  /** `/up` — or what `SERVER_HEALTH_PATH` says. */
  readonly path: string;
  readonly readyPath: string;
  live(): Response;
  ready(): Promise<Response>;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** How long `/up/ready` answers with the result of its last run — failing results too. */
export const READY_CACHE_MS = 1000;

/** The endpoints for `application`, under `path`. `debug`: the details of each check in the answer. */
export function createHealthEndpoints(application: Application, container: Container, { path, debug }: { path: string; debug: boolean }): HealthEndpoints {
  const closing = container.has(ServerClosing) ? container.make(ServerClosing) : undefined;
  const checks = application.container.has(HealthChecks) ? application.container.make(HealthChecks) : new HealthChecks();
  const clock = application.container.has(Clock) ? application.container.make(Clock) : { now: () => Date.now() };
  // Readiness ends when the server stops taking new work — at the signal, before SERVER_SHUTDOWN_DELAY_SECONDS; liveness only when it closes.
  const draining = () => closing?.draining.aborted === true;
  const closed = () => closing?.signal.aborted === true;
  // Probes arrive from several places at once (load balancer, orchestrator): one run serves every request that comes while it
  // runs — and, for a second after it ended, every one that comes then.
  let running: Promise<HealthReport> | undefined;
  let last: { report: HealthReport; at: number } | undefined;
  const report = (): HealthReport | Promise<HealthReport> => {
    if (last && clock.now() - last.at < READY_CACHE_MS) return last.report;
    running ??= checks
      .run(container)
      .then((result) => {
        last = { report: result, at: clock.now() };
        return result;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  return {
    path,
    readyPath: `${path === '/' ? '' : path}/ready`,
    live: () =>
      closed()
        ? new Response('Service Unavailable', { status: 503, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } })
        : new Response('OK', { status: 200, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } }),
    ready: async () => {
      if (draining()) return Response.json({ status: 'draining' }, { status: 503, headers: NO_STORE });
      const result = await report();
      const status = result.ok ? 'ok' : 'failing';
      if (!debug) return Response.json({ status }, { status: result.ok ? 200 : 503, headers: NO_STORE });
      const redactor = application.container.has(Redactor) ? application.container.make(Redactor) : new Redactor();
      return Response.json(
        {
          status,
          checks: result.checks.map((check) => ({
            name: check.name,
            status: check.status,
            ms: check.ms,
            ...(check.note === undefined ? {} : { note: redactor.text(check.note) }),
            ...(check.error === undefined ? {} : { error: redactor.text(check.error instanceof Error ? check.error.message : String(check.error)) }),
          })),
        },
        { status: result.ok ? 200 : 503, headers: NO_STORE },
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
      `The route${name} (${route.methods.join('|')} ${route.path}) is where the health check answers — it would never be reached. ` +
        `Give the route another path, or move the health check: SERVER_HEALTH_PATH=/healthz (or SERVER_HEALTH_PATH=off).`,
    );
  }
}
