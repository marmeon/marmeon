import { defineConfig, type ConfigOf } from './config.ts';
import { env } from './env.ts';

/**
 * How long `app.shutdown()` waits for each provider's `shutdown()` before it logs a warning and goes on with the next one.
 * See docs/providers.md#shutting-down.
 */
export const ShutdownConfig = defineConfig('shutdown', {
  env: env({
    /**
     * Seconds a provider's `shutdown()` may take. Default 10 — as long as the server waits for the work after its responses.
     * A provider that takes longer is left behind (its promise is not cancelled), so the providers before it in the order
     * (the database pool, the queue) still stop. Keep the sum with `SERVER_SHUTDOWN_DELAY_SECONDS` below the supervisor's grace period.
     */
    APP_SHUTDOWN_TIMEOUT_SECONDS: env.number('Expected seconds, like 10 or 0.5').min(0.1, 'Expected at least 0.1 seconds').max(300, 'Expected at most 300 seconds').default(10),
  }),
  resolve: (e) => ({
    /** The limit for one provider's `shutdown()`, in milliseconds. */
    providerMs: Math.round(e.APP_SHUTDOWN_TIMEOUT_SECONDS * 1000),
  }),
});
export type ShutdownConfig = ConfigOf<typeof ShutdownConfig>;
