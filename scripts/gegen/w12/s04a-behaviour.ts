import { defineGegenproben } from '../define.ts';

/**
 * W12.4a — the behaviour findings of the docs wave. A case per finding whose fix is a measure against recurrence; the case's id is
 * the finding's number.
 *
 * - **The image's health check follows `HEALTH_PATH=off`** (G6) — without the switch it fetches `http://127.0.0.1:3000off` and the
 *   container turns unhealthy although the app runs.
 * - **`marmeon <command> --help` prints the command's help** (G7) — without `wantsHelp()` the flag is an unknown option: exit 1.
 */
const HEALTHCHECK = { vitest: 'packages/cli/src/make-docker.test.ts', name: 'checks nothing with HEALTH_PATH=off' } as const;
const COMMAND_HELP = { vitest: 'packages/cli/src/cli.test.ts', name: 'for --help, without running it' } as const;

export default defineGegenproben({
  step: 'W12.4a',
  cases: [
    {
      id: 'G6',
      title: 'the health check ignores HEALTH_PATH=off: it fetches 127.0.0.1:3000off and fails, the container turns unhealthy',
      patch: [{ file: 'packages/cli/src/docker.ts', find: "p==='off'?process.exit(0):fetch(", replace: 'fetch(' }],
      run: HEALTHCHECK,
      expect: /expected 1 to be \+0/,
    },
    {
      id: 'G7',
      title: '--help is not asked for: marmeon make:controller --help fails with "Unknown option" (exit 1)',
      patch: [{ file: 'packages/cli/src/command.ts', find: "return flags.some((flag) => (flag === '--help' || flag === '-h')", replace: "return flags.some((flag) => (flag === '--nohelp' || flag === '-h')" }],
      run: COMMAND_HELP,
      expect: /expected 1 to be \+0/,
    },
  ],
});
