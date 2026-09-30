import { defineConfig, type ConfigOf, type ServiceProvider } from '@bespokecore/core';
import * as v from 'valibot';

export const ServerConfig = defineConfig('server', {
  env: v.object({
    PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(65535)), '3000'),
  }),
  resolve: (env) => ({ port: env.PORT }),
});
export type ServerConfig = ConfigOf<typeof ServerConfig>;

/** Brings the server's configuration. Found by `bespoke discover` like any installed package. */
export class ServerServiceProvider implements ServiceProvider {
  static config = [ServerConfig];
}
