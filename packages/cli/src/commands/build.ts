import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runtimeConditions, writeInjectionArtifacts, writeManifest } from '@bespokecore/core';
import { bespokeEntries, explainConfigError, importVite, ViteSetupError } from '@bespokecore/server';
import type { CommandInput } from '../command.ts';
import { precompressAssets } from '../precompress.ts';
import { typecheckApp } from '../typecheck.ts';

/**
 * Builds the client bundle and the SSR bundle with the app's own Vite. The `bespoke()` plugin
 * from `@bespokecore/vite` decides entries and output (`dist/client`, `dist/server/ssr.js`).
 * First, `bespoke route:types` brings `bootstrap/routes.ts` and `.bespoke/routes.json` up to date — the plugin builds
 * the bundle's route manifest from the latter — in a process of its own, with the app in its build phase (E187): every provider
 * registered, none booted, the configuration that does not validate left out — no `.env`, no key, no connection needed, and
 * so no secret that could end up in `dist/`.
 * Then the app is type-checked against it, like `next build`: a renamed route or a missing view fails the build.
 * `--no-typecheck` skips that. A route name the client bundle cannot know (built at runtime) fails it too, and so does
 * client code that imports a server module (a controller, a job …) as a value (E121).
 * Before anything else it precomputes the app's injection lists (`.bespoke/injections.json`, E138): the analysis the load
 * hook runs, kept per module with the hash of its source — a production start applies them instead of parsing the app
 * with oxc (and so does the `route:types` process this command starts, which boots the app).
 * The client's assets get a `.br` and a `.gz` next to them (E162), which the server sends by `Accept-Encoding`.
 * Last, it writes the production discovery manifest (E160) — the one `bespoke start` reads, resolved without the monorepo's
 * source condition — so the first start rewrites nothing and `.bespoke/` may be read-only from then on.
 */
export class BuildCommand {
  static command = 'build';
  static description = 'Build the app for production (client + SSR)';
  static usage = '[--no-typecheck]';
  static options = { 'no-typecheck': { type: 'boolean' } } as const;
  static boots = false;

  async handle({ options, output, root, spawn }: CommandInput): Promise<number> {
    if (existsSync(join(root, 'bootstrap', 'app.ts'))) {
      const injections = writeInjectionArtifacts({ root });
      output.success(`Precomputed the injection lists of ${injections.modules} module${injections.modules === 1 ? '' : 's'} → ${relative(root, injections.path)}`);
    }
    if (existsSync(join(root, 'bootstrap', 'app.ts')) && (await spawn('route:types')) !== 0) {
      output.error('Not built: bespoke route:types failed (it registers the app without booting it, E187 — see its error above).');
      return 1;
    }
    if (options['no-typecheck'] !== true) {
      const checked = await typecheckApp(root);
      if (checked.status === 'missing') {
        output.error('Not built: TypeScript is not installed in this app — pnpm add -D typescript (or build with --no-typecheck).');
        return 1;
      }
      if (checked.status === 'failed') {
        process.stdout.write(checked.output.endsWith('\n') ? checked.output : `${checked.output}\n`);
        const errors = `${checked.errors} type error${checked.errors === 1 ? '' : 's'}`;
        const files = checked.files > 0 ? ` in ${checked.files} file${checked.files === 1 ? '' : 's'}` : '';
        output.error(`Not built: ${errors}${files} (tsc --noEmit). Fix them — or build anyway with --no-typecheck.`);
        return 1;
      }
      if (checked.status === 'passed') output.success('Type-checked the app');
    }
    try {
      const vite = await importVite(root);
      const shared = { root, configLoader: 'native' as const, logLevel: 'warn' as const };
      // Fail before building anything if the config is not set up for BespokeCore. Resolving sets
      // NODE_ENV when it is unset, so it must be a production resolve — or the build bundles React's dev build.
      const config = await vite.resolveConfig(shared, 'build', 'production', 'production').catch((error: unknown) => {
        throw explainConfigError(error);
      });
      bespokeEntries(config);
      await vite.build(shared);
      await vite.build({ ...shared, build: { ssr: true } });
    } catch (error) {
      const problems = pluginProblems(error);
      if (problems) {
        for (const line of [...problems.routes, ...problems.imports]) output.error(line);
        const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
        if (problems.routes.length > 0) output.error(`Not built: ${count(problems.routes.length, 'route name', 'route names')} the browser's route manifest cannot be built from.`);
        if (problems.imports.length > 0) output.error(`Not built: ${count(problems.imports.length, 'import brings', 'imports bring')} server code into the browser.`);
        return 1;
      }
      if (!(error instanceof ViteSetupError)) throw error;
      output.error(error.message);
      return 1;
    }
    output.success('Built dist/client and dist/server');
    // Compressed once, here (E162): the server sends these by Accept-Encoding and never compresses per request (BREACH).
    const compressed = await precompressAssets(join(root, 'dist', 'client', 'assets'));
    if (compressed.files > 0) {
      const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
      output.success(`Compressed ${compressed.files} asset${compressed.files === 1 ? '' : 's'} (.br, .gz): ${kb(compressed.bytes)} → ${kb(compressed.brotliBytes)} with Brotli`);
    }
    // What `bespoke start` resolves with: Node's conditions and NODE_OPTIONS' — never this process's `@bespokecore/source`.
    if (existsSync(join(root, 'package.json'))) {
      const manifest = writeManifest({ root, conditions: runtimeConditions([], process.env.NODE_OPTIONS ?? '') });
      output.success(`Discovered ${manifest.packages.length} packages → ${relative(root, manifest.path)}`);
    }
    return 0;
  }
}

/**
 * The messages of the route collector (`bespokecore:routes`) and of the server-import check (`bespokecore:server-imports`)
 * in `@bespokecore/vite` — readable on their own, no stack. Anything else is thrown on.
 */
function pluginProblems(error: unknown): { routes: string[]; imports: string[] } | undefined {
  const errors = (error as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const plugins = { 'bespokecore:routes': 'routes', 'bespokecore:server-imports': 'imports' } as const;
  const problems = { routes: [] as string[], imports: [] as string[] };
  for (const entry of errors as { plugin?: unknown; message?: unknown }[]) {
    const kind = plugins[entry.plugin as keyof typeof plugins];
    if (kind === undefined) return undefined;
    problems[kind].push(...String(entry.message ?? '').split('\n').filter(Boolean));
  }
  return problems;
}
