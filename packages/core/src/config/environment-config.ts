import { environment, type NodeEnvironmentName } from '../environment.ts';
import { defineConfig, type ConfigOf } from './config.ts';
import { env } from './env.ts';

/**
 * The app's environment, read like every other variable: `node` (`NODE_ENV`, a missing one is `production`) and `app`
 * (`APP_ENV`, by default `local`, `testing` or `production`). Every app has it. `app` only names the environment — never ask
 * it whether to protect something or to run a development tool: that is `environment.isProtected()` and
 * `environment.isDevelopment()`. See docs/configuration.md#asking-for-the-environment-in-code.
 */
export const EnvironmentConfig = defineConfig('environment', {
  env: env({
    NODE_ENV: env.string().optional(),
    APP_ENV: env.string().optional(),
  }),
  resolve: (e) => ({
    /** `NODE_ENV`: what the development tools and the protections follow. */
    node: (environment.name(e) ?? 'production') as NodeEnvironmentName,
    /** `APP_ENV`, or the name that goes with `NODE_ENV` (`local`, `testing`, `production`). */
    app: environment.app(e),
  }),
});
export type EnvironmentConfig = ConfigOf<typeof EnvironmentConfig>;
