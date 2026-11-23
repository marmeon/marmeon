import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** The virtual module an app's setup file imports (docs/vite.md#packages-of-your-workspace). */
const TEST_PACKAGES = 'virtual:marmeon/test-packages';
const RESOLVED_TEST_PACKAGES = `\0${TEST_PACKAGES}`;
/** The prefix of the id a test's importer asks for: the file's URL follows, base64url encoded. Not declared and not documented. */
const PACKAGE_PREFIX = 'virtual:marmeon/test-package/';
/** The symbol `@marmeon/core` looks the importer up by. */
const IMPORTER = "Symbol.for('marmeon.test.import')";
const MINIMUM = [5, 1, 1] as const;

/** The part of Vitest's `configureVitest` context this plugin reads, typed here so the plugin needs no dependency on Vitest. */
interface VitestContext {
  readonly vitest?: { readonly version?: string } | undefined;
}

/** The version as `[major, minor, patch]` when it is a plain x.y.z; else `undefined` (a prerelease or an unknown form is not trusted). */
function plainVersion(version: string | undefined): readonly number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (const [index, part] of minimum.entries()) {
    if (version[index]! !== part) return version[index]! > part;
  }
  return true;
}

/**
 * `virtual:marmeon/test-packages`, only with `marmeon({ test: true })`. In a server environment of Vitest it makes the module runner the one
 * that imports the workspace packages discovery boots, so a test and the booted app share one instance; elsewhere (a simulated browser) it
 * only takes a registered importer away. Nothing changes until a project imports it.
 */
export function testPackages(): Plugin {
  let version: string | undefined;

  const plugin: Plugin & { configureVitest(context?: VitestContext): void } = {
    name: 'marmeon:test-packages',
    enforce: 'pre',
    // Called by Vitest for every project that has this plugin; it changes no config.
    configureVitest(context) {
      // Read tolerantly: a stand-in of Vitest's context may lack either. An unknown version refuses at the import, never here.
      version = context?.vitest?.version;
    },
    async resolveId(source) {
      if (source === TEST_PACKAGES) return RESOLVED_TEST_PACKAGES;
      if (!source.startsWith(PACKAGE_PREFIX)) return undefined;
      // Only a server environment resolves a file URL of the test: the client environment answers over HTTP and must resolve no file.
      if (this.environment.config.consumer !== 'server') return undefined;
      // The file the importer was asked for is the file that runs: what Vite resolves it to must be that very file, a module of the package,
      // and not the sibling a `#` or `?` of its name cuts it down to, an alias, or a file a plugin resolved as external.
      let file: string;
      try {
        file = fileURLToPath(Buffer.from(source.slice(PACKAGE_PREFIX.length), 'base64url').toString('utf8'));
      } catch {
        return this.error(`The test importer was asked for something that is no file URL: ${source}.`);
      }
      const resolved = await this.resolve(file, undefined, { skipSelf: true });
      if (!resolved) return this.error(`Vite could not resolve ${file}, a module of your workspace packages.`);
      if (resolved.external) return this.error(`A plugin resolved ${file} as external, so it would be a second copy loaded through Node.`);
      if (/[?#]/.test(resolved.id)) {
        return this.error(
          resolved.id === file
            ? `${file} has a "?" or "#" in its name, which the module runner cuts off, so it cannot load that file. Rename the file.`
            : `Vite resolved ${file} to ${resolved.id}, which is not that file (a "?" or "#" in a name cuts it). Rename the file.`,
        );
      }
      let same = false;
      try {
        same = realpathSync.native(file) === realpathSync.native(resolved.id);
      } catch {
        // not readable: not the same file
      }
      if (!same) return this.error(`Vite resolved ${file} to ${resolved.id}, which is another file (an alias or a link?). The checked file would not be the one that runs.`);
      return resolved.id;
    },
    load(id) {
      if (id !== RESOLVED_TEST_PACKAGES) return undefined;
      if (this.environment.config.consumer !== 'server') return `delete globalThis[${IMPORTER}];\n`;
      const parsed = plainVersion(version);
      if (!parsed || !atLeast(parsed, MINIMUM)) {
        this.error(`virtual:marmeon/test-packages needs Vitest ${MINIMUM.join('.')} or newer (${version === undefined ? 'its version is unknown here' : `this is ${version}`}). Install it with: pnpm add -D vitest@^${MINIMUM.join('.')}`);
      }
      if (this.environment.config.resolve.preserveSymlinks) {
        this.error('virtual:marmeon/test-packages cannot work with resolve.preserveSymlinks: true, which keeps a linked package under a path of its own. Remove that option from the test config.');
      }
      return (
        `globalThis[${IMPORTER}] = (url) =>\n` +
        `  import(/* @vite-ignore */ ${JSON.stringify(PACKAGE_PREFIX)} + btoa(url).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));\n`
      );
    },
  };
  return plugin;
}
