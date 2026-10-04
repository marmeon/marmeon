/**
 * What `NODE_ENV` means to the framework — the one place that decides it (E115, E139).
 *
 * Two rules, and they are not mirror images of each other:
 * - **Development tools** (Vite's dev server, the error page's details, the devtools, `Server-Timing`, the mail previews,
 *   pretty logs, regenerated table types) run **only** with `NODE_ENV=development` — never with "anything but production".
 * - **Protections** (JSON logs, `migrate` asking for `--force`, the boot warnings, no lab pages) apply to **every**
 *   `NODE_ENV` except `development` and `test` — fail-closed: `staging`, `production`, a typo and a missing `NODE_ENV`
 *   are all protected.
 *
 * Every function reads `process.env` unless given the environment a config definition resolves from (`env` of `defineConfig`).
 */
export interface NodeEnvironment {
  readonly NODE_ENV?: string | undefined;
}

function nodeEnv(env: NodeEnvironment): string | undefined {
  return env.NODE_ENV || undefined; // an empty NODE_ENV is a missing one
}

export const environment = {
  /** `NODE_ENV` as set — `undefined` when it is missing (or empty). */
  name(env: NodeEnvironment = process.env): string | undefined {
    return nodeEnv(env);
  },

  /** `NODE_ENV=development`: the development tools run (E115) — and only here. */
  isDevelopment(env: NodeEnvironment = process.env): boolean {
    return nodeEnv(env) === 'development';
  },

  /** `NODE_ENV=test`: the test runner. Neither development tools nor protections. */
  isTest(env: NodeEnvironment = process.env): boolean {
    return nodeEnv(env) === 'test';
  },

  /**
   * Protections apply (E139): every `NODE_ENV` but `development` and `test` — `production`, `staging`, anything else and a
   * missing one. Check this on the protecting side, never `=== 'production'`.
   */
  isProtected(env: NodeEnvironment = process.env): boolean {
    const name = nodeEnv(env);
    return name !== 'development' && name !== 'test';
  },

  /**
   * The environment as a start line names it: `production (protected)`, `staging (protected)`, `development`, `test` —
   * and `unset NODE_ENV (protected, like production)`.
   */
  describe(env: NodeEnvironment = process.env): string {
    const name = nodeEnv(env);
    if (name === undefined) return 'unset NODE_ENV (protected, like production)';
    return environment.isProtected(env) ? `${name} (protected)` : name;
  },
} as const;
