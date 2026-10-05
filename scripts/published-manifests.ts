/**
 * `node scripts/published-manifests.ts <dir>` — gives the framework packages of a `pnpm deploy` output the manifests they are
 * published with. `pnpm deploy` copies a workspace package's files, but not as `pnpm pack` would: its `package.json` keeps the
 * workspace's `exports` with the `@bespokecore/source` condition, so `bespoke` takes the copy for the monorepo and starts Node
 * with that condition — and Node refuses TypeScript under `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Here
 * `publishConfig` replaces the fields it names, as `pnpm pack` does (`access`, `provenance`, `registry` and `tag` only steer the
 * publish). Used by `apps/docs/Dockerfile`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLISH_ONLY = new Set(['access', 'provenance', 'registry', 'tag']);
const SOURCE_CONDITION = '@bespokecore/source';

interface Manifest {
  name?: string;
  publishConfig?: Record<string, unknown>;
  [field: string]: unknown;
}

/** Every `@bespokecore/*` package installed under `dir` (the real directories, each once). */
export function frameworkCopies(dir: string): string[] {
  const found = new Set<string>();
  const scan = (modules: string) => {
    const scope = join(modules, '@bespokecore');
    if (!existsSync(scope)) return;
    for (const name of readdirSync(scope)) found.add(realpathSync(join(scope, name)));
  };
  scan(join(dir, 'node_modules'));
  const store = join(dir, 'node_modules/.pnpm');
  if (existsSync(store)) for (const entry of readdirSync(store)) scan(join(store, entry, 'node_modules'));
  return [...found].sort();
}

/** Applies `publishConfig` to one manifest; returns whether it changed. */
export function publishManifest(file: string): boolean {
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  const { publishConfig, ...rest } = manifest;
  if (!publishConfig) return false;
  const published: Manifest = { ...rest };
  for (const [field, value] of Object.entries(publishConfig)) if (!PUBLISH_ONLY.has(field)) published[field] = value;
  writeFileSync(file, `${JSON.stringify(published, null, 2)}\n`);
  return true;
}

function main(): number {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/published-manifests.ts <dir of a pnpm deploy>');
    return 2;
  }
  const copies = frameworkCopies(dir);
  if (copies.length === 0) {
    console.error(`published-manifests: no @bespokecore/* package under ${dir}/node_modules`);
    return 1;
  }
  const left: string[] = [];
  for (const copy of copies) {
    const file = join(copy, 'package.json');
    publishManifest(file);
    if (readFileSync(file, 'utf8').includes(SOURCE_CONDITION)) left.push(copy);
  }
  if (left.length > 0) {
    console.error(`published-manifests: still the ${SOURCE_CONDITION} condition in ${left.join(', ')} — publishConfig.exports missing?`);
    return 1;
  }
  console.log(`published-manifests: ${copies.length} framework packages as published`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
