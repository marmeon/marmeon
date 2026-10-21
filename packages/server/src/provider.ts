import { defineConfig, env, environment, type Application, type ConfigOf, type Container, type ServiceProvider } from '@marmeon/core';
import { DevDocument } from './dev-document.ts';
import { DevRequestRecorder, type RequestRecorder } from './error-page/recorder-token.ts';
import { isProxyEntry } from './proxies.ts';
import { ServerTiming } from './server-timing.ts';

const UNITS = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const;

/** `8m` → 8388608: bytes, or a size with a unit (`k`, `m`, `g`, any case). */
function bytes(size: string): number {
  return Number.parseInt(size, 10) * UNITS[(size.match(/[kmg]$/i)?.[0].toLowerCase() ?? '') as keyof typeof UNITS];
}

export const ServerConfig = defineConfig('server', {
  env: env({
    /** The port to listen on; `0` asks the system for a free one (the start line names the port it got). */
    PORT: env.integer().min(0).max(65_535).default(3000),
    /**
     * The interface the server listens on: default `127.0.0.1`, this machine only (`marmeon dev`, behind a proxy on the same
     * host); `0.0.0.0` or `::`: every interface (a container, a PaaS, a phone testing `marmeon dev`).
     */
    HOST: env.string().default('127.0.0.1'),
    /** Largest accepted request body: bytes, or with a unit — `512k`, `8m`, `1g`. */
    SERVER_MAX_BODY_SIZE: env.string().regex(/^\d+[kmg]?$/i, 'Expected bytes or a size like 512k, 8m or 1g').default('8m'),
    /**
     * The app's proxies (load balancers), comma-separated: addresses or ranges — `127.0.0.1,10.0.0.0/8,fd00::/8` — or
     * `*` when the app is only reachable through its own proxy. Only from these, `X-Forwarded-For` sets `ctx.ip` and
     * `X-Forwarded-Proto`/`X-Forwarded-Host` the request's URL (`https://…`). Default: none — the headers are ignored.
     */
    SERVER_TRUSTED_PROXIES: env
      .list(env.string())
      .check(
        (entries) => entries.every(isProxyEntry),
        (entries) => `Expected addresses or ranges like 10.0.0.0/8, or *: ${entries.filter((entry) => !isProxyEntry(entry)).join(', ')} is not one`,
      )
      .default([]),
    /** Overrides the asset version derived from the build — e.g. the git commit of the deployment. */
    SERVER_ASSET_VERSION: env.string().optional(),
    /**
     * `false`: no server rendering — pages go out without markup and the browser renders them (single pages:
     * `Page.ssr = false`). Not `SSR`: Vite and Vitest set that one themselves.
     */
    SERVER_SSR_ENABLED: env.boolean().default(true),
    /**
     * Where the health endpoints answer: liveness at this path, readiness below it (`/up/ready`). `off`: neither —
     * e.g. when the app's own route needs `/up`.
     */
    SERVER_HEALTH_PATH: env.string().regex(/^(?:off|\/[\w./-]*[\w-])$/, 'Expected a path like /up or /healthz (no trailing slash), or off').default('/up'),
    /**
     * Seconds the server keeps taking requests after SIGTERM: `/up/ready` answers 503 at once, so a load balancer stops
     * sending new ones, and only then the server closes and drains. Default 0 — set it (5 is typical) behind a load
     * balancer that learns about a stopping instance only from its probes (kamal-proxy, Traefik, a cloud load balancer).
     */
    SERVER_SHUTDOWN_DELAY_SECONDS: env.number('Expected seconds, like 5 or 0.5').min(0, 'Expected seconds, like 5 or 0.5').max(300, 'Expected at most 300 seconds').default(0),
    /**
     * Seconds an idle keep-alive connection stays open. Default 65 — longer than the proxy in front keeps its idle
     * connections to the app (nginx's upstream `keepalive_timeout` 60 s, an AWS load balancer's idle timeout 60 s): the side that
     * closes first must be the proxy, or a request it sends on a connection the app is just closing fails (a 502). Behind a proxy
     * that keeps them longer (a Google load balancer: 600 s) set it above that.
     */
    SERVER_KEEP_ALIVE_TIMEOUT_SECONDS: env
      .integer('Expected seconds, like 65')
      .min(0, 'Expected seconds, like 65')
      .min(1, 'Expected at least 1 second')
      .max(3600, 'Expected at most 3600 seconds')
      .default(65),
    /** The app's own address: its host is one the development server writes `last-error.md` for (besides the loopback names). */
    APP_URL: env.string().optional(),
    NODE_ENV: env.string().optional(),
  })
    .renamed('MAX_BODY_SIZE', 'SERVER_MAX_BODY_SIZE')
    .renamed('HEALTH_PATH', 'SERVER_HEALTH_PATH')
    .renamed('ASSET_VERSION', 'SERVER_ASSET_VERSION')
    .renamed('SHUTDOWN_DELAY', 'SERVER_SHUTDOWN_DELAY_SECONDS')
    .renamed('KEEP_ALIVE_TIMEOUT', 'SERVER_KEEP_ALIVE_TIMEOUT_SECONDS')
    .renamed('TRUSTED_PROXIES', 'SERVER_TRUSTED_PROXIES')
    .renamed('SSR_ENABLED', 'SERVER_SSR_ENABLED'),
  resolve: (e) => ({
    port: e.PORT,
    /** The interface to listen on (env `HOST`, default 127.0.0.1). */
    host: e.HOST,
    maxBodySize: bytes(e.SERVER_MAX_BODY_SIZE),
    assetVersion: e.SERVER_ASSET_VERSION,
    appUrl: e.APP_URL,
    trustedProxies: e.SERVER_TRUSTED_PROXIES,
    ssr: e.SERVER_SSR_ENABLED,
    /** The liveness path of the health endpoints (readiness: `<path>/ready`), or `false` without them. */
    health: e.SERVER_HEALTH_PATH === 'off' ? (false as const) : e.SERVER_HEALTH_PATH,
    /** How long the server keeps taking requests after SIGTERM, not ready any more, in milliseconds. */
    shutdownDelayMs: Math.round(e.SERVER_SHUTDOWN_DELAY_SECONDS * 1000),
    /** How long an idle keep-alive connection stays open, in milliseconds — above the proxy's (`SERVER_KEEP_ALIVE_TIMEOUT_SECONDS`). */
    keepAliveTimeoutMs: e.SERVER_KEEP_ALIVE_TIMEOUT_SECONDS * 1000,
    /** The `Server-Timing` header: only when `NODE_ENV=development` — not in tests, never in production. */
    serverTiming: environment.isDevelopment(e),
    /**
     * Development error handling: the error page with code, request, queries and solutions, exception details in
     * JSON errors, the Vite overlay for server-rendering errors. Only when `NODE_ENV=development` — never "not production":
     * a production or test server shows the plain error page, whatever `APP_ENV` says.
     */
    debug: environment.isDevelopment(e),
  }),
});
export type ServerConfig = ConfigOf<typeof ServerConfig>;

/**
 * Brings the server's configuration — and, in development only, the `Server-Timing` header and the error page's
 * request recorder: both listen to the app's channels until the app shuts down. In production neither is loaded,
 * and no channel gets a subscriber. Found by `marmeon discover` like any installed package.
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
