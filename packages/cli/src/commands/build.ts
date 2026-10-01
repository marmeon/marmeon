import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bespokeEntries, explainConfigError, importVite, ViteSetupError } from '@bespokecore/server';
import type { CommandInput } from '../command.ts';
import { typecheckApp } from '../typecheck.ts';

/**
 * Builds the client bundle and the SSR bundle with the app's own Vite. The `bespoke()` plugin
 * from `@bespokecore/vite` decides entries and output (`dist/client`, `dist/server/ssr.js`).
 * First, `bespoke route:types` brings `bootstrap/routes.ts` and `.bespoke/routes.json` up to date — the plugin builds
 * the bundle's route manifest from the latter — in a process of its own, as it boots the app (this command does not).
 * Then the app is type-checked against it, like `next build`: a renamed route or a missing view fails the build.
 * `--no-typecheck` skips that. A route name the client bundle cannot know (built at runtime) fails it too.
 */
export class BuildCommand {
  static command = 'build';
  static description = 'Build the app for production (client + SSR)';
  static usage = '[--no-typecheck]';
  static options = { 'no-typecheck': { type: 'boolean' } } as const;
  static boots = false;

  async handle({ options, output, root, spawn }: CommandInput): Promise<number> {
    if (existsSync(join(root, 'bootstrap', 'app.ts')) && (await spawn('route:types')) !== 0) {
      output.error('Not built: bespoke route:types failed (it boots the app — is .env complete?).');
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
      const problems = routeNameProblems(error);
      if (problems) {
        for (const line of problems) output.error(line);
        output.error(`Not built: ${problems.length} route name${problems.length === 1 ? '' : 's'} the browser's route manifest cannot be built from.`);
        return 1;
      }
      if (!(error instanceof ViteSetupError)) throw error;
      output.error(error.message);
      return 1;
    }
    output.success('Built dist/client and dist/server');
    return 0;
  }
}

/** The messages of the route collector (`bespokecore:routes` in `@bespokecore/vite`) — readable on their own, no stack. */
function routeNameProblems(error: unknown): string[] | undefined {
  const errors = (error as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  if (!errors.every((entry) => (entry as { plugin?: unknown }).plugin === 'bespokecore:routes')) return undefined;
  return errors.flatMap((entry) => String((entry as { message?: unknown }).message ?? '').split('\n').filter(Boolean));
}
