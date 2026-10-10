import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as validation from './index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function declarations(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? declarations(join(dir, entry.name)) : entry.name.endsWith('.d.ts') ? [join(dir, entry.name)] : [],
  );
}

describe('@marmeon/validation: Valibot stays inside', () => {
  it('is a dependency of the package — the app installs nothing for it', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    expect(manifest.dependencies?.valibot).toMatch(/^\^1\.\d+\.\d+$/);
    expect(manifest.peerDependencies?.valibot).toBeUndefined();
  });

  it('no declaration file names it: an app that emits .d.ts for its schemas never needs valibot (TS2742)', () => {
    const dist = join(root, 'dist');
    expect(existsSync(join(dist, 'index.d.ts')), 'run pnpm build first: this test reads dist/').toBe(true);
    const naming = declarations(dist).filter((file) => readFileSync(file, 'utf8').includes('valibot'));
    expect(naming, `declarations that name valibot: ${naming.join(', ')}`).toEqual([]);
  });

  it('re-exports nothing of it: what the package exports is its own', () => {
    expect(Object.keys(validation).sort()).toEqual(['ArrayRule', 'NumberRule', 'ObjectRule', 'Rule', 'StringRule', 'VALIDATION_TEXTS', 'metaOf', 'rules']);
  });
});
