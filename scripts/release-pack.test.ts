import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releasePack, SUMS_FILE } from './release-pack.ts';
import { tempDir } from './test/temp-dir.js';

const sha512 = (data: string) => createHash('sha512').update(data).digest('hex');

/** A repository with these published packages and a private one. */
function repository(...names: readonly string[]): string {
  const root = tempDir('marmeon-release-pack-');
  for (const name of [...names, '@marmeon/internal']) {
    const dir = join(root, 'packages', name.replace('@marmeon/', ''));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', private: name === '@marmeon/internal' }));
  }
  return root;
}

/** A packer that writes one tarball per package directory (private ones too, as `pnpm --filter './packages/*' pack` does). */
const fakePack = (root: string, destination: string) =>
  readdirSync(join(root, 'packages')).map((short) => {
    const name = `@marmeon/${short}`;
    const tarball = join(destination, `marmeon-${short}-1.2.3.tgz`);
    writeFileSync(tarball, `contents of ${name}`);
    return { name, tarball };
  });

describe('releasePack', () => {
  it('names every published tarball in SHA512SUMS, in sha512sum’s format, and returns the hash of that file', () => {
    const root = repository('@marmeon/core', '@marmeon/auth');
    const directory = join(tempDir('marmeon-release-pack-'), 'tarballs');
    const result = releasePack(root, directory, fakePack);

    expect(result.tarballs).toEqual(['marmeon-auth-1.2.3.tgz', 'marmeon-core-1.2.3.tgz']);
    const sums = readFileSync(join(directory, SUMS_FILE), 'utf8');
    expect(sums).toBe(`${sha512('contents of @marmeon/auth')}  marmeon-auth-1.2.3.tgz\n${sha512('contents of @marmeon/core')}  marmeon-core-1.2.3.tgz\n`);
    expect(result.sums).toBe(sha512(sums));
  });

  it('leaves a private package out of the sums, so it is never staged', () => {
    const directory = join(tempDir('marmeon-release-pack-'), 'tarballs');
    releasePack(repository('@marmeon/core'), directory, fakePack);
    expect(readFileSync(join(directory, SUMS_FILE), 'utf8')).not.toContain('internal');
  });

  it('refuses a directory that already holds files', () => {
    const directory = tempDir('marmeon-release-pack-');
    writeFileSync(join(directory, 'old-0.0.1.tgz'), 'x');
    expect(() => releasePack(repository('@marmeon/core'), directory, fakePack)).toThrow('is not empty');
  });

  it('throws when a published package made no tarball', () => {
    const directory = join(tempDir('marmeon-release-pack-'), 'tarballs');
    const root = repository('@marmeon/core', '@marmeon/auth');
    expect(() => releasePack(root, directory, (r, d) => fakePack(r, d).filter((entry) => entry.name !== '@marmeon/auth'))).toThrow('no tarball for @marmeon/auth');
  });
});
