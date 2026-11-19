import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRAMEWORK_PACKAGES } from './framework/packages.ts';
import { repo } from './__fixtures__/cli.js';

const read = (file: string) => JSON.parse(readFileSync(join(repo, file), 'utf8')) as { name: string; private?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** The directory and manifest of every published package of the repository except the creator. */
const published = readdirSync(join(repo, 'packages'))
  .filter((dir) => existsSync(join(repo, 'packages', dir, 'package.json')))
  .map((dir) => ({ dir, manifest: read(`packages/${dir}/package.json`) }))
  .filter(({ manifest }) => manifest.private !== true && manifest.name !== 'create-marmeon');

// `marmeon add` hands only these names to a package manager: the list must be the repository's packages, no more and no fewer.
describe('FRAMEWORK_PACKAGES', () => {
  it('names exactly the published packages except create-marmeon', () => {
    expect([...FRAMEWORK_PACKAGES.keys()].sort()).toEqual(published.map(({ manifest }) => manifest.name).sort());
  });

  it('marks the packages that ship migrations', () => {
    for (const { dir, manifest } of published) {
      expect(FRAMEWORK_PACKAGES.get(manifest.name)?.migrations, manifest.name).toBe(existsSync(join(repo, 'packages', dir, 'stubs/migrations')));
    }
  });

  it('agrees with the blank app on which packages are development dependencies', () => {
    const blank = read('apps/blank-app/package.json');
    for (const name of Object.keys(blank.devDependencies ?? {}).filter((dependency) => FRAMEWORK_PACKAGES.has(dependency))) expect(FRAMEWORK_PACKAGES.get(name)?.dev, name).toBe(true);
    for (const name of Object.keys(blank.dependencies ?? {}).filter((dependency) => FRAMEWORK_PACKAGES.has(dependency))) expect(FRAMEWORK_PACKAGES.get(name)?.dev, name).toBe(false);
  });

  it('points every package to a page of the documentation', () => {
    for (const [name, { docs }] of FRAMEWORK_PACKAGES) expect(existsSync(join(repo, 'docs', `${docs}.md`)), `${name} → docs/${docs}.md`).toBe(true);
  });
});
