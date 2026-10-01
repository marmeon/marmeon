import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bespokeEntries, explainConfigError, importVite, ViteSetupError } from '@bespokecore/server';
import type { CommandInput } from '../command.ts';

/**
 * Builds the client bundle and the SSR bundle with the app's own Vite. The `bespoke()` plugin
 * from `@bespokecore/vite` decides entries and output (`dist/client`, `dist/server/ssr.js`).
 * First, `bespoke route:types` brings `bootstrap/routes.ts` up to date — the bundle carries its route manifest —
 * in a process of its own, as it boots the app (this command does not).
 */
export class BuildCommand {
  static command = 'build';
  static description = 'Build the app for production (client + SSR)';
  static boots = false;

  async handle({ output, root, spawn }: CommandInput): Promise<number> {
    if (existsSync(join(root, 'bootstrap', 'app.ts')) && (await spawn('route:types')) !== 0) {
      output.error('Not built: bespoke route:types failed (it boots the app — is .env complete?).');
      return 1;
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
