import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST = /\.(?:test|spec|type-test)\.[cm]?[jt]sx?$/;
/** Left out below the app root only (`modules/storage/` is an app's own code); `node_modules` is left out everywhere. */
const SKIPPED_AT_ROOT = new Set(['dist', 'storage', 'coverage']);

interface Options {
  /** Include `*.test.*`, `*.spec.*` and `*.type-test.*` files. */
  readonly tests: boolean;
  /** Include `tsconfig*.json` and `package.json`. */
  readonly configs?: boolean;
}

/** Whether `name` is a JavaScript or TypeScript source file. */
export function isSource(name: string): boolean {
  return SOURCE.test(name);
}

/**
 * The files the scans of `marmeon check` read, depth first in name order: JavaScript and TypeScript sources, and with `configs`
 * `tsconfig*.json` and `package.json`. No `node_modules`, no dot directory, no symlink, and `dist`, `storage` and `coverage` only
 * at the app root. A directory that cannot be read is skipped.
 */
export function sourceFiles(root: string, options: Options): string[] {
  return filesUnder(root, root, options);
}

function filesUnder(root: string, directory: string, options: Options): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name).split('\\').join('/');
    if (entry.isDirectory()) {
      const skipped = entry.name === 'node_modules' || entry.name.startsWith('.') || (directory === root && SKIPPED_AT_ROOT.has(entry.name));
      if (!skipped) for (const file of filesUnder(root, path, options)) files.push(file);
    } else if (entry.isFile()) {
      const source = SOURCE.test(entry.name) && (options.tests || !TEST.test(entry.name));
      const config = options.configs === true && (/^tsconfig.*\.json$/.test(entry.name) || entry.name === 'package.json');
      if (source || config) files.push(path);
    }
  }
  return files;
}
