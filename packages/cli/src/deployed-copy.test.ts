import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { marmeon, repo, webApp } from './__fixtures__/cli.js';

/**
 * A workspace package copied under `node_modules` — what `pnpm deploy` (and injected workspace dependencies) leave: the copy keeps
 * the workspace manifest, whose `exports` name the source condition. It runs its `dist/` like a published package; started with
 * the source condition, Node would refuse its TypeScript (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
 */
describe('marmeon from a copy of the workspace package (pnpm deploy)', { timeout: 30_000 }, () => {
  it('is no monorepo: no source condition, the built dist/', () => {
    const app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-deployed-')));
    try {
      const cli = join(app, 'node_modules/marmeon');
      // As pnpm deploy writes it: a workspace of the app alone — the copy under node_modules is none of its packages.
      writeFileSync(join(app, 'pnpm-workspace.yaml'), "packages:\n- '.'\ninjectWorkspacePackages: false\n");
      // The CLI copied with its workspace manifest and sources; its dependencies as installed (here: links to the built packages).
      for (const part of ['bin', 'src', 'dist', 'package.json']) cpSync(join(repo, 'packages/cli', part), join(cli, part), { recursive: true });
      mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true }); // the CLI is unscoped: nothing made the scope's directory
      for (const name of ['core', 'server', 'http', 'router', 'encryption', 'log']) symlinkSync(join(repo, 'packages', name), join(app, 'node_modules/@marmeon', name), 'dir');
      expect(readFileSync(join(cli, 'package.json'), 'utf8')).toContain('"@marmeon/source"');
      const { MARMEON_CHILD: _child, NODE_OPTIONS: _options, ...parent } = process.env;
      const result = spawnSync(process.execPath, [join(cli, 'bin/marmeon.js'), 'list'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, NODE_ENV: 'production' } });
      expect(result.stderr).not.toContain('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
      expect(result.stdout).toContain('make:module');
      expect(result.status).toBe(0);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  }, 30_000);

  it('knows the monorepo by its workspace, not by a manifest: a pnpm-workspace.yaml above the package lists its directory', async () => {
    const { inWorkspace, listedIn } = (await import(new URL('../bin/workspace.js', import.meta.url).href)) as { inWorkspace(dir: string): boolean; listedIn(yaml: string, path: string): boolean };
    expect(inWorkspace(join(repo, 'packages/cli'))).toBe(true);
    expect(inWorkspace(join(webApp, 'node_modules/marmeon'))).toBe(true); // the app's link resolves to the workspace package
    const yaml = "# the workspace\npackages:\n  - 'packages/*'\n  - \"apps/**\" # apps\n  - '!apps/legacy/**'\ncatalog:\n  - nope\n";
    expect(['packages/cli', 'apps/shop', 'apps/a/b'].map((path) => listedIn(yaml, path))).toEqual([true, true, true]);
    expect(['packages/cli/sub', 'apps/legacy/x', 'nope', 'node_modules/.pnpm/x/node_modules/marmeon', 'packages/node_modules'].map((path) => listedIn(yaml, path))).toEqual([false, false, false, false, false]);
    expect(listedIn("packages:\n- '.'\n", '')).toBe(false);
    expect(listedIn("packages:\n- packages/*\nother: 1\n", 'packages/cli')).toBe(true); // a sequence need not be indented
    expect(listedIn('onlyBuiltDependencies:\n  - esbuild\n', 'packages/cli')).toBe(false);
  });

  it('a package that brings its TypeScript sources: the start says Node’s code and how to fix it', () => {
    const app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-shipped-ts-')));
    try {
      writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
      mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true });
      symlinkSync(join(repo, 'packages/core'), join(app, 'node_modules/@marmeon/core'), 'dir');
      mkdirSync(join(app, 'node_modules/shipped'));
      writeFileSync(join(app, 'node_modules/shipped/package.json'), JSON.stringify({ name: 'shipped', type: 'module', exports: './index.ts' }));
      writeFileSync(join(app, 'node_modules/shipped/index.ts'), 'export const value: number = 1;\n');
      mkdirSync(join(app, 'bootstrap'));
      writeFileSync(join(app, 'bootstrap/app.ts'), "import { join } from 'node:path';\nimport { defineApplication } from '@marmeon/core';\nimport 'shipped';\nexport default defineApplication({ root: join(import.meta.dirname, '..') });\n");
      const { code, stdout, stderr } = marmeon(app, ['route:list'], { NODE_ENV: 'production' });
      expect(code).toBe(1);
      expect(stderr).toContain('(ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)');
      expect(stdout).toContain('How to fix it: Install the package as it is published');
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  }, 30_000);
});
