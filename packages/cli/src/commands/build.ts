import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bespokeEntries, explainConfigError, importVite, ViteSetupError } from '@bespokecore/server';
import type { CommandInput } from '../command.ts';
import { typecheckApp } from '../typecheck.ts';

/**
 * Builds the client bundle and the SSR bundle with the app's own Vite. The `bespoke()` plugin
 * from `@bespokecore/vite` decides entries and output (`dist/client`, `dist/server/ssr.js`).
 * First, `bespoke route:types` brings `bootstrap/routes.ts` up to date — the bundle carries its route manifest —
 * in a process of its own, as it boots the app (this command does not). Then the app is type-checked against it,
 * like `next build`: a renamed route or a missing view fails the build. `--no-typecheck` skips that.
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
      if (!(error instanceof ViteSetupError)) throw error;
      output.error(error.message);
      return 1;
    }
    output.success('Built dist/client and dist/server');
    return 0;
  }
}
