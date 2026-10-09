import { environment, type NodeEnvironmentName } from '../environment.ts';
import { defineConfig, type ConfigOf } from './config.ts';
import { env } from './env.ts';

/**
 * The app's environment, read like every other variable (`.env`, `.env.{NODE_ENV}`, then the real environment): `NODE_ENV` —
 * `development`, `test` or `production`, as the start checked it (a missing one is `production`) — and `APP_ENV`, the app's own
 * name for it (`local`, `staging`, `production`, one of its own; by default `local`, `testing` or `production`). Every app has it
 * (`createApplication` adds it), so the framework and the app read the same one:
 *
 * ```ts
 * class ShowStatusController {
 *   readonly #environment: EnvironmentConfig;   // { node: 'production', app: 'staging' }
 *   constructor(environment: EnvironmentConfig) {
 *     this.#environment = environment;
 *   }
 *   handle() {
 *     return { environment: this.#environment.app };
 *   }
 * }
 * ```
 *
 * `app` names the environment — the start line, the logs, the traces, a label on a page — and selects the scheduled tasks
 * (`.environments(…)`). Never ask it whether to protect something or to run a development tool: that is
 * `environment.isProtected()` and `environment.isDevelopment()`, which read `NODE_ENV` alone.
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
