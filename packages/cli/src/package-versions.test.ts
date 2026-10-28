import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';

const blank = join(repo, 'apps/blank-app');
const version = (JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')) as { version: string }).version;

/**
 * A copy of the blank app with a command whose class takes a constructor argument and has no injection list (plain JavaScript, which
 * the loader leaves alone) — the start of the command fails with K3. `storage` is an installed `@marmeon/storage` in that version.
 */
function appWithBrokenCommand(storage?: string): string {
  const root = realpathSync(tempDir('marmeon-versions-'));
  cpSync(blank, root, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
  mkdirSync(join(root, 'storage'));
  writeFileSync(join(root, 'modules/system/Broken.js'), "export class BrokenCommand {\n  static command = 'broken';\n  static description = 'Broken';\n  constructor(dependency) {\n    this.dependency = dependency;\n  }\n  handle() {}\n}\n");
  writeFileSync(
    join(root, 'modules/system/index.ts'),
    "import { defineModule } from '@marmeon/core';\nimport { BrokenCommand } from './Broken.js';\nexport default defineModule({ name: 'system', commands: [BrokenCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
  );
  if (storage !== undefined) {
    // The blank app's node_modules, entry by entry, so that one more package can be installed beside them.
    const modules = join(root, 'node_modules');
    mkdirSync(join(modules, '@marmeon'), { recursive: true });
    for (const entry of readdirSync(join(blank, 'node_modules'))) if (entry !== '@marmeon') symlinkSync(join(blank, 'node_modules', entry), join(modules, entry));
    for (const entry of readdirSync(join(blank, 'node_modules/@marmeon'))) symlinkSync(join(blank, 'node_modules/@marmeon', entry), join(modules, '@marmeon', entry));
    mkdirSync(join(modules, '@marmeon/storage'));
    writeFileSync(join(modules, '@marmeon/storage/package.json'), JSON.stringify({ name: '@marmeon/storage', version: storage }));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.dependencies['@marmeon/storage'] = storage;
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  } else {
    symlinkSync(join(blank, 'node_modules'), join(root, 'node_modules'), 'dir');
  }
  return root;
}

describe('a start that fails with K3', { timeout: 60_000 }, () => {
  it('names the @marmeon packages that are not in the version of the app', () => {
    const { code, stderr } = marmeon(appWithBrokenCommand('0.4.0'), ['broken']);
    expect(code).toBe(1);
    expect(stderr).toContain('[marmeon:K3]');
    expect(stderr).toContain(`@marmeon/storage is 0.4.0, the app's framework is ${version}`);
    expect(stderr).toContain(`pnpm add -E @marmeon/storage@${version}`);
  });

  it('says nothing about versions when they are all alike', () => {
    const { code, stderr } = marmeon(appWithBrokenCommand(), ['broken']);
    expect(code).toBe(1);
    expect(stderr).toContain('[marmeon:K3]');
    expect(stderr).not.toContain('not in one version');
  });
});
