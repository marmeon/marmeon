import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from './test/temp-dir.js';
import { zizmorVersion, ZIZMOR_ARGS } from './zizmor.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const pinned = () => zizmorVersion(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'))!;

/** Runs the script with a `PATH` of this directory alone, so only the zizmor in it (if any) can be found. */
function run(path: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/zizmor.ts')], { cwd: root, encoding: 'utf8', env: { PATH: path } });
}

/** A directory with a `zizmor` that reports `version` for --version and otherwise prints its arguments and exits with `code`. */
function fakeZizmor(version: string, code: number): string {
  const directory = tempDir('marmeon-zizmor-');
  const file = join(directory, 'zizmor');
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "zizmor ${version}"; exit 0; fi\necho "args: $*"\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return directory;
}

describe('zizmorVersion — the version ci.yml runs', () => {
  it('reads an exact version from the repository’s ci.yml', () => {
    expect(pinned()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is undefined without a zizmor job, or without an exact version in it', () => {
    expect(zizmorVersion('jobs:\n  check:\n    name: check\n    steps:\n      - run: echo\n')).toBeUndefined();
    expect(zizmorVersion('jobs:\n  zizmor:\n    name: zizmor\n    steps:\n      - uses: zizmorcore/zizmor-action@v1\n        with:\n          version: latest\n')).toBeUndefined();
  });

  it('does not read the version of the job after it', () => {
    expect(zizmorVersion('jobs:\n  zizmor:\n    name: zizmor\n  other:\n    steps:\n      - with:\n          version: 1.2.3\n')).toBeUndefined();
  });
});

describe('pnpm zizmor', () => {
  it('is skipped (exit 75) with the way to install it when zizmor is not installed', () => {
    const result = run(tempDir('marmeon-zizmor-'));
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('not installed');
    expect(result.stderr).toMatch(/uv tool install zizmor==\d+\.\d+\.\d+/);
  });

  it('hands the regular persona, offline audits and the repository to zizmor, and turns its finding red', () => {
    const result = run(fakeZizmor(pinned(), 13));
    expect(result.status).toBe(13);
    expect(result.stdout).toContain(`args: ${ZIZMOR_ARGS.join(' ')}`);
    expect(result.stderr).toBe('');
  });

  it('passes when zizmor does', () => {
    expect(run(fakeZizmor(pinned(), 0)).status).toBe(0);
  });

  it('notes another version and runs anyway', () => {
    const result = run(fakeZizmor('0.0.1', 13));
    expect(result.status).toBe(13);
    expect(result.stderr).toContain('zizmor 0.0.1 is installed');
    expect(result.stdout).toContain('args:');
  });
});
