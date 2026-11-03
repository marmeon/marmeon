/**
 * Vitest global setup of the repository (`vitest.config.ts`): the tests of the `marmeon` package read the documentation it ships
 * (`packages/cli/docs`), which only `pnpm build` writes and git ignores. When that copy is missing, this makes it once per run —
 * before any worker starts, so no test reads a half-written directory.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { shipDocs } from '../docs-ship.ts';

const root = join(import.meta.dirname, '..', '..');

export default async function setup(): Promise<void> {
  const target = join(root, 'packages/cli');
  if (!existsSync(join(target, 'docs/index.json'))) await shipDocs(root, target);
}
