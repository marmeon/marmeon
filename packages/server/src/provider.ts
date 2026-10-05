import { defineConfig, environment, type Application, type ConfigOf, type Container, type ServiceProvider } from '@bespokecore/core';
import { DevDocument } from './dev-document.ts';
import { DevRequestRecorder, type RequestRecorder } from './error-page/recorder-token.ts';
import { isProxyEntry } from './proxies.ts';
import { ServerTiming } from './server-timing.ts';
import * as v from 'valibot';

const UNITS = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const;

export const ServerConfig = defineConfig('server', {
  env: v.object({
    /** The port to listen on; `0` asks the system for a free one (the start line names the port it got). */
    PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0), v.maxValue(65535)), '3000'),
    /**
     * The interface the server listens on (E162): unset — every interface (Node's default), `127.0.0.1` — this machine only
     * (behind a proxy on the same host), `0.0.0.0` — every IPv4 interface (a container).
     */
    HOST: v.optional(v.pipe(v.string(), v.nonEmpty())),
    /** Largest accepted request body: bytes, or with a unit — `512k`, `8m`, `1g`. */
    MAX_BODY_SIZE: v.optional(
      v.pipe(
        v.string(),
        v.regex(/^\d+[kmg]?$/i, 'Expected bytes or a size like 512k, 8m or 1g'),
        v.transform((size) => Number.parseInt(size, 10) * UNITS[(size.match(/[kmg]$/i)?.[0].toLowerCase() ?? '') as keyof typeof UNITS]),
      ),
      '8m',
    ),
    /**
     * The app's proxies (load balancers, E162), comma-separated: addresses or ranges — `127.0.0.1,10.0.0.0/8,fd00::/8` — or
     * `*` when the app is only reachable through its own proxy. Only from these, `X-Forwarded-For` sets `ctx.ip` and
     * `X-Forwarded-Proto`/`X-Forwarded-Host` the request's URL (`https://…`). Default: none — the headers are ignored.
     */
    TRUSTED_PROXIES: v.optional(
      v.pipe(
        v.string(),
        v.transform((value) => value.split(',').map((proxy) => proxy.trim()).filter(Boolean)),
        v.check(
          (entries) => entries.every(isProxyEntry),
          (issue) => `Expected addresses or ranges like 10.0.0.0/8, or *: ${(issue.input as string[]).filter((entry) => !isProxyEntry(entry)).join(', ')} is not one`,
        ),
      ),
      '',
    ),
    /** Overrides the asset version derived from the build — e.g. the git commit of the deployment. */
    ASSET_VERSION: v.optional(v.pipe(v.string(), v.nonEmpty())),
    /**
     * `false`: no server rendering — pages go out without markup and the browser renders them (single pages:
     * `Page.ssr = false`). Not `SSR`: Vite and Vitest set that one themselves.
     */
    SSR_ENABLED: v.optional(v.picklist(['true', 'false']), 'true'),
    /**
     * Where the health endpoints answer (E126): liveness at this path, readiness below it (`/up/ready`). `off`: neither —
     * e.g. when the app's own route needs `/up`.
     */
    HEALTH_PATH: v.optional(
      v.union([v.literal('off'), v.pipe(v.string(), v.regex(/^\/[\w./-]*[\w-]$/, 'Expected a path like /up or /healthz (no trailing slash), or off'))]),
      '/up',
    ),
    /**
     * Seconds the server keeps taking requests after SIGTERM (E163): `/up/ready` answers 503 at once, so a load balancer stops
     * sending new ones, and only then the server closes and drains (E102). Default 0 — set it (5 is typical) behind a load
     * balancer that learns about a stopping instance only from its probes (kamal-proxy, Traefik, a cloud load balancer).
     */
    SHUTDOWN_DELAY: v.optional(
      v.pipe(v.string(), v.regex(/^\d+(\.\d+)?$/, 'Expected seconds, like 5 or 0.5'), v.transform(Number), v.maxValue(300, 'Expected at most 300 seconds')),
      '0',
    ),
    NODE_ENV: v.optional(v.string()),
  }),
  resolve: (env) => ({
    port: env.PORT,
    /** The interface to listen on; undefined: every interface. */
    host: env.HOST,
    maxBodySize: env.MAX_BODY_SIZE,
    assetVersion: env.ASSET_VERSION,
    trustedProxies: env.TRUSTED_PROXIES,
    ssr: env.SSR_ENABLED === 'true',
    /** The liveness path of the health endpoints (readiness: `<path>/ready`), or `false` without them (E126). */
    health: env.HEALTH_PATH === 'off' ? (false as const) : env.HEALTH_PATH,
    /** How long the server keeps taking requests after SIGTERM, not ready any more (E163), in milliseconds. */
    shutdownDelayMs: Math.round(env.SHUTDOWN_DELAY * 1000),
    /** The `Server-Timing` header (E129): only when `NODE_ENV=development` — not in tests, never in production. */
    serverTiming: environment.isDevelopment(env),
    /**
     * Development error handling (E115, E119): the error page with code, request, queries and solutions, exception details in
     * JSON errors, the Vite overlay for server-rendering errors. Only when `NODE_ENV=development` — never "not production":
     * a staging or test server shows the plain error page.
     */
    debug: environment.isDevelopment(env),
  }),
});
export type ServerConfig = ConfigOf<typeof ServerConfig>;

/**
 * Brings the server's configuration — and, in development only, the `Server-Timing` header (E129) and the error page's
 * request recorder (E119): both listen to the app's channels until the app shuts down. In production neither is loaded,
 * and no channel gets a subscriber. Found by `bespoke discover` like any installed package.
 */
export class ServerServiceProvider implements ServiceProvider {
  static config = [ServerConfig];

  #timing: ServerTiming | undefined;
  #recorder: RequestRecorder | undefined;

  register(container: Container): void {
    // What packages add to the development documents (the devtools' link) — bound before any provider boots, never in production.
    if (container.make(ServerConfig).debug) container.instance(DevDocument, new DevDocument());
  }

  async boot(app: Application): Promise<void> {
    const config = app.container.make(ServerConfig);
    if (config.serverTiming) {
      this.#timing = new ServerTiming(app);
      app.container.instance(ServerTiming, this.#timing);
    }
    if (config.debug) {
      // Loaded only here: a production server never imports the error page's code.
      const { createRequestRecorder } = await import('./error-page/recorder.ts');
      this.#recorder = createRequestRecorder(app);
      app.container.instance(DevRequestRecorder, this.#recorder);
    }
  }

  shutdown(): void {
    this.#timing?.close();
    this.#timing = undefined;
    this.#recorder?.close();
    this.#recorder = undefined;
  }
}
