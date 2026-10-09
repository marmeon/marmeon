import { defineGegenproben } from '../define.ts';

/**
 * W12.2 — staging is `NODE_ENV=production APP_ENV=staging` (E217): `NODE_ENV` is `development`, `test` or `production`, anything
 * else stops the start; `APP_ENV` names the environment and changes nothing; `marmeon build` builds the browser's files for
 * production unless the environment says `development`. The measures, each with its own cases:
 *
 * - **An unknown `NODE_ENV` stops the start** — the one check (`environment.check()`) taken out (G1), `NODE_ENV=staging` resolves
 *   again. Every entry point asks it, each its own case: `resolveEnvironment` — the `marmeon` launcher of every command (G1b),
 *   `createApplication` for an app given its own environment (G1c), `startServer` (G1d). G1 masks G1b–G1d (one function).
 * - **`APP_ENV` opens nothing** — read by the development question, `APP_ENV=local` on production opens the devtools' routes (G2);
 *   read by the protection question, it migrates without `--force` (G2b).
 * - **The client is production's unless `NODE_ENV=development`** — `NODE_ENV=test` kept for the build (G3) reaches it; in the packed
 *   framework, an app built with `NODE_ENV=test` ships its development branches (G3b, `pack:smoke`).
 * - **The start line names `APP_ENV`** — the line without it (G4, in the built server `marmeon start` runs); `describe()` without
 *   it, every line that names the environment loses the name (G4b).
 * - **Scheduled tasks are selected by `APP_ENV`** (E221) — compared against `NODE_ENV` again, a staging server runs the tasks of
 *   `.environments('production')` and never those of `.environments('staging')` (G5).
 */
const ENV = 'packages/core/src/environment.ts';
const environmentTest = (name: string) => ({ vitest: 'packages/core/src/environment.test.ts', name }) as const;
const CHECK = { file: ENV, find: '    if (problem === undefined) return;\n    const error = new ConfigError(', replace: '    if (problem === undefined || problem !== undefined) return;\n    const error = new ConfigError(' };

export default defineGegenproben({
  step: 'W12.2',
  cases: [
    // --- An unknown NODE_ENV stops the start --------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'environment.check() lets every value through: NODE_ENV=staging resolves again — no start error',
      patch: [CHECK],
      run: environmentTest('any other NODE_ENV stops the start, with the hint'),
      expect: /expected function to throw an error, but it didn't/,
      masks: 'G1b',
    },
    {
      id: 'G1b',
      title: 'resolveEnvironment does not ask the check: the marmeon launcher (every command) takes NODE_ENV=staging from the process and from .env',
      patch: [
        {
          file: ENV,
          find: '  // Nothing reads the environment before it is known to be one (E217): an unknown NODE_ENV stops here.\n  environment.check(env);\n',
          replace: '',
        },
      ],
      run: environmentTest('stops at a NODE_ENV that is none of development, test, production'),
      expect: /expected \[Function\] to throw an error/,
      masks: 'G1',
    },
    {
      id: 'G1c',
      title: 'createApplication does not ask the check: an app given its own env boots with NODE_ENV=staging',
      patch: [{ file: 'packages/core/src/application.ts', find: '  environment.check(env);\n', replace: '' }],
      run: { vitest: 'packages/core/src/application.test.ts', name: 'stops the start at a NODE_ENV that is none of' },
      expect: /promise resolved .* instead of rejecting/,
    },
    {
      id: 'G1d',
      title: 'startServer does not ask the check: NODE_ENV=staging set after the boot serves (here: looks for the build)',
      patch: [{ file: 'packages/server/src/kernel.ts', find: '  environment.check();\n  const mode = chosenMode', replace: '  const mode = chosenMode' }],
      run: { vitest: 'packages/server/src/start-server.test.ts', name: "runs Vite's dev server only with NODE_ENV=development" },
      expect: /to throw error matching \/NODE_ENV=staging is not an environmen.* but got 'No production build in dist\/client/,
    },
    // --- APP_ENV opens nothing ----------------------------------------------------------------------------------------------------
    {
      id: 'G2',
      title: 'isDevelopment() asks APP_ENV too: APP_ENV=local on production registers the devtools\' routes',
      patch: [
        {
          file: ENV,
          find: "  isDevelopment(env: NodeEnvironment = process.env): boolean {\n    return nodeEnv(env) === 'development';",
          replace: "  isDevelopment(env: NodeEnvironment = process.env): boolean {\n    return nodeEnv(env) === 'development' || env.APP_ENV === 'local';",
        },
      ],
      run: { vitest: 'packages/devtools/src/pages.test.ts', name: 'do not exist with' },
      expect: /expected \[ '\/_marmeon\/devtools'.* to deeply equal \[\]/,
    },
    {
      id: 'G2b',
      title: 'isProtected() asks APP_ENV too: APP_ENV=local on production migrates without --force',
      patch: [
        {
          file: ENV,
          find: "    const name = nodeEnv(env);\n    return name !== 'development' && name !== 'test';",
          replace: "    const name = nodeEnv(env);\n    return name !== 'development' && name !== 'test' && env.APP_ENV !== 'local';",
        },
      ],
      run: { vitest: 'packages/cli/src/cli.test.ts', name: 'asks for --force wherever the app is protected' },
      expect: /APP_ENV=local on production migrated without --force: expected \+0 to be 1/,
    },
    // --- The client is production's unless NODE_ENV=development ---------------------------------------------------------------------
    {
      id: 'G3',
      title: 'buildEnvironment keeps NODE_ENV=test: the build folds test into the browser code (development branches, React\'s development build)',
      patch: [{ file: ENV, find: "  env.NODE_ENV = 'production';\n  delete env[DOTENV_MARKER];", replace: "  if (name !== 'test') env.NODE_ENV = 'production';\n  delete env[DOTENV_MARKER];" }],
      run: environmentTest('test builds for production'),
      expect: /NODE_ENV=test reached the build: expected 'test' to be 'production'/,
      masks: 'G3b',
    },
    {
      id: 'G3b',
      title: 'the packed framework keeps NODE_ENV=test for the build: npm run build of a blank app ships its development branches',
      patch: [
        {
          file: 'packages/core/dist/environment.js',
          find: "    env.NODE_ENV = 'production';\n    delete env[DOTENV_MARKER];",
          replace: "    if (name !== 'test')\n        env.NODE_ENV = 'production';\n    delete env[DOTENV_MARKER];",
        },
      ],
      run: { command: ['pnpm', 'run', 'pack:smoke'], timeout: 15 * 60_000 },
      expect: /NODE_ENV=test npm run build built a development client — assets\/[\w.-]+\.js/,
      masks: 'G3',
    },
    // --- The start line names APP_ENV -----------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'the start line without APP_ENV (the built server marmeon start runs): a staging server reads "Marmeon in production"',
      patch: [
        {
          file: 'packages/server/dist/kernel.js',
          find: 'Marmeon in ${environment.describe(process.env, named)} on',
          replace: "Marmeon in ${environment.name() ?? 'production'} on",
        },
      ],
      run: { vitest: 'packages/cli/src/cli.test.ts', name: 'runs a staging server as production named by APP_ENV' },
      expect: /expected 'Marmeon in production on http:\/\/127\.0…' to match \/\^Marmeon in production \\\(APP_ENV=sta/,
    },
    {
      id: 'G4b',
      title: 'describe() without APP_ENV: every line that names the environment (migrate, the worker, the scheduler) loses the name',
      patch: [{ file: ENV, find: '    const notes = [`APP_ENV=${app}`, ', replace: '    const notes = [' }],
      run: environmentTest('development tools only in development, protections everywhere but development and test'),
      expect: /expected 'production \(\)' to be 'production \(APP_ENV=production\)'/,
    },
    // --- Scheduled tasks are selected by APP_ENV --------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'environments() compares against NODE_ENV again: a staging server runs production\'s tasks (customer mails) and never its own',
      patch: [{ file: 'packages/scheduler/src/config.ts', find: 'environment: environment.app(e) }),', replace: "environment: environment.name(e) ?? 'production' })," }],
      run: { vitest: 'packages/scheduler/src/scheduler.test.ts', name: 'selects the tasks by APP_ENV' },
      expect: /NODE_ENV=production APP_ENV=staging: expected \[ 'production-only', 'both' \] to deeply equal \[ 'staging-only', 'both' \]/,
    },
  ],
});
