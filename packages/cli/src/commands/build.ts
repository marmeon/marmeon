import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CommandInput } from '../command.ts';

/** Builds the client bundle and the SSR bundle with the app's own Vite. */
export class BuildCommand {
  static command = 'build';
  static description = 'Build the app for production (client + SSR)';
  static boots = false;

  async handle({ output, root }: CommandInput): Promise<number> {
    let vite: { build(config: object): Promise<unknown> };
    try {
      // The app's Vite, not one bundled with the CLI.
      vite = await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('vite')).href);
    } catch {
      output.error('Vite is not installed in this app (pnpm add -D vite).');
      return 1;
    }
    const shared = { root, configLoader: 'native' as const, logLevel: 'warn' as const };
    await vite.build({ ...shared, build: { outDir: 'dist/client' } });
    await vite.build({ ...shared, build: { ssr: 'bootstrap/ssr.tsx', outDir: 'dist/server' } });
    output.success('Built dist/client and dist/server');
    return 0;
  }
}
