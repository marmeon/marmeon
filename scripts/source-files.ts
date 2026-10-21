/** What the repository's checks share to read source: a file as git lists it, oxc-parser, and which files are a package's code. */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export interface SourceFile {
  /** Relative to the repository, forward slashes. */
  readonly path: string;
  readonly text: string;
}

/** What the checks use of oxc-parser: an ESTree program, its comments and the errors of a file it cannot read. */
export interface OxcParser {
  parseSync(filename: string, text: string): {
    program: unknown;
    comments: readonly { type: string; value: string; start: number }[];
    errors: readonly { message: string }[];
  };
}
/** oxc-parser — the parser of `@marmeon/core` (the scripts run from the repository's root, which does not depend on it). */
export const oxc = (): OxcParser => createRequire(join(root, 'packages/core/package.json'))('oxc-parser') as OxcParser;

/** A package's code as an app runs it: `packages/<name>/src/`, without tests, type tests and fixtures. */
export const PACKAGE_CODE = /^packages\/([^/]+)\/src\/(?!.*__fixtures__\/).+(?<!\.test|\.type-test)\.tsx?$/;

/**
 * Paths the repository's checks leave alone: the snapshot of a release line is the text of an old release, frozen byte for byte
 * (`pnpm website:lines verify` holds it to its commit), so a rule written today must not fail on it, and nobody edits it to satisfy one.
 */
export const FROZEN_PATHS = ['apps/website/content/lines/'] as const;
