import { defineConfig, type ConfigOf, type ServiceProvider } from '@bespokecore/core';
import * as v from 'valibot';

const UNITS = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const;

export const ServerConfig = defineConfig('server', {
  env: v.object({
    PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(65535)), '3000'),
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
     * Proxies (load balancers) whose `X-Forwarded-For` is believed, comma-separated IPs — or `*`
     * when the app is only reachable through its own proxy. Without it, `ctx.ip` is the peer address.
     */
    TRUSTED_PROXIES: v.optional(
      v.pipe(
        v.string(),
        v.transform((value) => value.split(',').map((proxy) => proxy.trim()).filter(Boolean)),
      ),
      '',
    ),
    /** Overrides the asset version derived from the build — e.g. the git commit of the deployment. */
    ASSET_VERSION: v.optional(v.pipe(v.string(), v.nonEmpty())),
  }),
  resolve: (env) => ({
    port: env.PORT,
    maxBodySize: env.MAX_BODY_SIZE,
    assetVersion: env.ASSET_VERSION,
    trustedProxies: env.TRUSTED_PROXIES,
  }),
});
export type ServerConfig = ConfigOf<typeof ServerConfig>;

/** Brings the server's configuration. Found by `bespoke discover` like any installed package. */
export class ServerServiceProvider implements ServiceProvider {
  static config = [ServerConfig];
}
