import { defineGegenproben } from '../define.ts';

/**
 * W9.2 — the start and build leftovers (E187): the build phase (`bespoke build` without `.env` and without a key), tini as the
 * image's PID 1, the monorepo known by its workspace (a `pnpm deploy` copy without `published-manifests.ts`), the request line not
 * built at `LOG_LEVEL=silent`, a new app's `<title>`, the pnpm pin. The `dist/` cases need `pnpm build` first (pack:smoke and the
 * images pack what is built); the image cases need Docker and take minutes each.
 */
const cliTest = (name: string) => ({ vitest: 'packages/cli/src/cli.test.ts', name });
const coreBuildPhase = (name: string) => ({ vitest: 'packages/core/src/application.test.ts', name: `createApplication({ phase: "build" }) (E187) > ${name}` });
const createTest = (name: string) => ({ vitest: 'packages/create-bespoke-app/src/create.test.ts', name });
const MINUTES = 60_000;

export default defineGegenproben({
  step: 'W9.2',
  cases: [
    // --- The build phase (E187) ------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'route:types boots the app as a run, not in the build phase: without a key the route types cannot be written',
      patch: [{ file: 'packages/cli/src/main.ts', find: "builtIn?.boots === 'build' ? 'build' : 'run'", replace: "builtIn?.boots === 'build' ? 'run' : 'run'" }],
      run: cliTest('writes the route types without a secret'),
      expect: /not to contain 'Invalid configuration'/,
    },
    {
      id: 'G2',
      title: 'the build phase boots the providers after all (a boot that connects, checks drivers, reads secrets)',
      // Both: the early return, and the guard that refuses to boot an app of the build phase (it would say so instead).
      patch: [
        { file: 'packages/core/src/application.ts', find: "  if (phase === 'build') return app;\n", replace: '' },
        { file: 'packages/core/src/application.ts', find: "    if (this.phase === 'build') throw new Error(", replace: '    if (false) throw new Error(' },
      ],
      run: coreBuildPhase('registers every provider and boots none'),
      expect: /a provider booted in the build phase/,
      masks: 'G2b',
    },
    {
      id: 'G2b',
      title: 'the build phase validates every configuration as a run does: a missing APP_KEY fails it',
      patch: [{ file: 'packages/core/src/application.ts', find: "if (problems.size > 0 && phase === 'run') throw", replace: 'if (problems.size > 0) throw' }],
      run: coreBuildPhase('leaves out the configuration that does not validate'),
      expect: /Invalid configuration — the application cannot start/,
      masks: 'G2',
    },
    {
      id: 'G3',
      title: 'a new app built in a copy without .env (pack:smoke) — the packed CLI without the build phase',
      patch: [{ file: 'packages/cli/dist/main.js', find: "builtIn?.boots === 'build' ? 'build' : 'run'", replace: "builtIn?.boots === 'build' ? 'run' : 'run'" }],
      run: { command: ['pnpm', 'pack:smoke'], timeout: 10 * MINUTES },
      expect: /Invalid configuration — the application cannot start:[\s\S]*Not built: bespoke route:types failed/,
    },
    {
      id: 'G4',
      title: 'a placeholder secret in dist/ (an asset the build writes with a key in it) — the grep of pack:smoke',
      patch: [
        {
          file: 'packages/vite/dist/index.js',
          find: '        name: PLUGIN_NAME,\n',
          replace: "        name: PLUGIN_NAME,\n        generateBundle() { this.emitFile({ type: 'asset', fileName: 'assets/placeholder.txt', source: `APP_KEY=base64:${'A'.repeat(43)}=` }); },\n",
        },
      ],
      run: { command: ['pnpm', 'pack:smoke'], timeout: 10 * MINUTES },
      expect: /bespoke build wrote a secret \(or a placeholder key\) into its output: dist\/client\/assets\/placeholder\.txt/,
    },
    // --- tini (E187) -------------------------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'the image without tini: Node is PID 1 and an orphaned process stays a zombie',
      patch: [{ file: 'packages/cli/dist/docker.js', find: 'ENTRYPOINT ["/usr/bin/tini", "--", "bespoke"]', replace: 'ENTRYPOINT ["bespoke"]' }],
      run: { command: ['pnpm', 'image:smoke'], timeout: 25 * MINUTES },
      expect: /an orphaned process stayed a zombie \(<defunct>: \d+ sleep\)/,
    },
    {
      id: 'G6',
      title: 'tini that maps the exit code 70 to 0 (-e 70): a stuck worker would look like a clean stop',
      patch: [{ file: 'packages/cli/dist/docker.js', find: 'ENTRYPOINT ["/usr/bin/tini", "--", "bespoke"]', replace: 'ENTRYPOINT ["/usr/bin/tini", "-e", "70", "--", "bespoke"]' }],
      run: { command: ['pnpm', 'image:smoke'], timeout: 25 * MINUTES },
      expect: /the worker container ended with 0, expected 70/,
    },
    // --- The monorepo, known by its workspace (E187) -----------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'the launcher knows the monorepo by its own exports again: a pnpm deploy copy gets the source condition',
      patch: [
        {
          file: 'packages/cli/bin/bespoke.js',
          find: "inWorkspace(fileURLToPath(new URL('..', import.meta.url)))",
          replace: "JSON.stringify(JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')).exports ?? {}).includes('\"@bespokecore/source\"')",
        },
      ],
      run: cliTest('bespoke from a copy of the workspace package (pnpm deploy) > is no monorepo'),
      expect: /not to contain 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STR/,
    },
    {
      id: 'G7b',
      title: 'the docs image without published-manifests.ts and with the old detection: a command besides start fails in the copy',
      patch: [
        {
          file: 'packages/cli/bin/bespoke.js',
          find: "inWorkspace(fileURLToPath(new URL('..', import.meta.url)))",
          replace: "JSON.stringify(JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')).exports ?? {}).includes('\"@bespokecore/source\"')",
        },
      ],
      run: { command: ['pnpm', 'docs:image'], timeout: 20 * MINUTES },
      // Red already in the image's build: `bespoke discover` in the pnpm deploy copy (before route:types --check in the image could run).
      expect: /code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'/,
    },
    {
      id: 'X1',
      title: 'masking probe: without the node_modules rule the deploy copy is still no workspace package (its workspace lists "." only)',
      patch: [{ file: 'packages/cli/bin/workspace.js', find: "if (path === '' || path.split('/').includes('node_modules')) return false;", replace: "if (path === '') return false;" }],
      run: cliTest('bespoke from a copy of the workspace package (pnpm deploy) > is no monorepo'),
      expectGreen: true,
    },
    // --- LOG_LEVEL=silent (E187) -------------------------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'the kernel builds the request line (and redacts its path) whatever the level',
      patch: [{ file: 'packages/server/src/kernel.ts', find: "        if (logger.enabled?.('info') === false) return;\n", replace: '' }],
      run: { vitest: 'packages/server/src/kernel.test.ts', name: 'the request line at a level that discards it' },
      expect: /the request line was built at LOG_LEVEL=silent/,
      masks: 'G8b',
    },
    {
      id: 'G8b',
      title: 'the pino logger says every level is enabled — silent too',
      patch: [{ file: 'packages/log/src/index.ts', find: 'return this.#pino.isLevelEnabled(level) || (this.#app !== undefined && entries.hasSubscribers);', replace: 'return true;' }],
      run: { vitest: 'packages/log/src/log.test.ts', name: 'enabled(level)' },
      expect: /expected \[ true, true, true, true \] to deeply equal \[ false, false, false, false \]/,
      masks: 'G8',
    },
    // --- The scaffolder: <title>, pnpm ---------------------------------------------------------------------------------------------
    {
      id: 'G9',
      title: 'a new app titled "BespokeCore"',
      patch: [{ file: 'packages/create-bespoke-app/src/template.ts', find: '() => `<title>${escaped}</title>`', replace: "() => '<title>BespokeCore</title>'" }],
      run: createTest('writes the blank app: every file as apps/blank-app has it'),
      expect: /the title of a new app: expected 'BespokeCore' not to match/,
    },
    {
      id: 'G10',
      title: 'make:docker pins another pnpm than the repository (TESTED_PNPM left at 12.9.0)',
      patch: [{ file: 'packages/cli/src/docker.ts', find: "export const TESTED_PNPM = '12.9.1';", replace: "export const TESTED_PNPM = '12.9.0';" }],
      run: createTest('pins the pnpm the repository uses'),
      expect: /to contain 'export const TESTED_PNPM = \\'12\.9\.1\\';'/,
    },
  ],
});
