import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment } from '@marmeon/core';
import type { CommandInput } from '../command.ts';
import { rawWriter } from '../output.ts';

/**
 * Serves the app to coding agents over MCP on stdin and stdout: the routes and the last error, read only. Starts only with
 * `NODE_ENV=development` — from the environment or from the app's `.env` — and only in an app's root. There is no network
 * transport. Runs without booting the app: the tools start `marmeon` processes of their own. See docs/mcp.md#tools.
 */
export class McpCommand {
  static command = 'mcp';
  static description = 'Serve the app to coding agents over MCP (stdio, development only)';
  static usage = '';
  static boots = false;

  async handle({ output, root }: CommandInput): Promise<number> {
    // The development tools run with NODE_ENV=development and with nothing else; this check comes before the SDK is loaded.
    if (!environment.isDevelopment()) {
      output.error(`marmeon mcp runs only with NODE_ENV=development, not with NODE_ENV=${environment.describe()}. Set it in the environment or in the app's .env.`);
      return 1;
    }
    if (!isAppRoot(root)) {
      output.error("marmeon mcp serves the app in the current directory, and this is not an app's root (package.json with marmeon). Start your agent in the app's root.");
      return 1;
    }
    const { serve } = await import('../mcp/server.ts');
    return serve({ root, write: rawWriter(output) });
  }
}

/** Whether `root` holds a `package.json` that lists `marmeon`. */
function isAppRoot(root: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    return manifest.dependencies?.marmeon !== undefined || manifest.devDependencies?.marmeon !== undefined;
  } catch {
    return false;
  }
}
