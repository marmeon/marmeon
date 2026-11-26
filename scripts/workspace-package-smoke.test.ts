import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SmokeError } from './pack-smoke.ts';
import { checkWorkspacePackage, COMMANDS, sectionBlocks, type WorkspaceTarget } from './workspace-package-smoke.ts';
import { tempDir } from './test/temp-dir.js';

const PAGE = readFileSync(new URL('../docs/package-workspace.md', import.meta.url), 'utf8');
/** `PAGE` with `from` replaced once, inside the section only. */
const inSection = (from: string, to: string): string => {
  const start = PAGE.indexOf("\n## A package in your app's workspace\n");
  const at = PAGE.indexOf(from, start);
  expect(at).toBeGreaterThan(start);
  return PAGE.slice(0, at) + to + PAGE.slice(at + from.length);
};

describe('the section "A package in your app\'s workspace"', () => {
  it('parses, and its sh block holds the commands the smoke runs', () => {
    const { titled, commands } = sectionBlocks(PAGE);
    expect(commands).toEqual(COMMANDS);
    expect([...titled.keys()]).toContain('packages/status-board/src/index.ts');
  });

  it('names a block title that is missing', () => {
    const page = inSection('```ts title="modules/home/status.ts"', '```ts');
    expect(() => sectionBlocks(page)).toThrow('the section "A package in your app\'s workspace" has no block titled modules/home/status.ts.');
  });

  it('names a block title that stands twice', () => {
    const page = inSection('```json title="package.json"', '```json title="tsconfig.json"');
    expect(() => sectionBlocks(page)).toThrow('the section "A package in your app\'s workspace" has two blocks titled tsconfig.json.');
  });

  it('refuses a changed sh block', () => {
    const page = inSection('pnpm marmeon check\n', 'pnpm marmeon doctor\n');
    expect(() => sectionBlocks(page)).toThrow(/the sh block of "A package in your app's workspace" holds:\n[^]*pnpm marmeon doctor/);
  });

  it('refuses a second sh block', () => {
    const page = inSection('### What to watch for\n', '### What to watch for\n\n```sh\npnpm build\n```\n');
    expect(() => sectionBlocks(page)).toThrow('the section "A package in your app\'s workspace" must hold one sh block, it holds 2.');
  });
});

/** A target on a temporary app that holds a few files; `install` stands for the `pnpm install` that ends the restore. */
function target(install: (app: string) => void = (app) => rmSync(join(app, 'node_modules/@acme'), { recursive: true, force: true })) {
  const app = tempDir('marmeon-workspace-smoke-');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"app"}\n');
  writeFileSync(join(app, 'tsconfig.json'), '{}\n');
  const smoke = {
    app,
    env: {},
    run: (command: string, args: string[]) => {
      if (command === 'pnpm' && args[0] === 'install') install(app);
      return '';
    },
    buildWithoutEnv: () => '',
    serve: async () => undefined,
    launch: () => {
      throw new Error('the fake target starts nothing');
    },
  } satisfies WorkspaceTarget;
  return smoke;
}

describe('the restore of the app', () => {
  it('passes when the proof leaves the app as it was', async () => {
    const smoke = target();
    await checkWorkspacePackage(smoke, [], PAGE, async (app) => {
      writeFileSync(join(app.app, 'package.json'), '{"changed":true}\n');
      writeFileSync(join(app.app, 'extra.txt'), 'x');
      mkdirSync(join(app.app, 'packages/status-board'), { recursive: true });
      mkdirSync(join(app.app, 'node_modules/@acme'), { recursive: true });
    });
    expect(readFileSync(join(smoke.app, 'package.json'), 'utf8')).toBe('{"name":"app"}\n');
    expect(() => readFileSync(join(smoke.app, 'extra.txt'))).toThrow();
  });

  it('reports a file the install leaves behind, with its path', async () => {
    const smoke = target((app) => writeFileSync(join(app, 'left.txt'), 'x'));
    await expect(checkWorkspacePackage(smoke, [], PAGE, async () => undefined)).rejects.toThrow('the app is not as it was before the workspace package: left.txt');
  });

  it('reports a file the install changes, with its path', async () => {
    const smoke = target((app) => writeFileSync(join(app, 'tsconfig.json'), '{"a":1}\n'));
    await expect(checkWorkspacePackage(smoke, [], PAGE, async () => undefined)).rejects.toThrow('the app is not as it was before the workspace package: tsconfig.json');
  });

  it('reports a node_modules/@acme the install leaves', async () => {
    const smoke = target((app) => mkdirSync(join(app, 'node_modules/@acme/status-board'), { recursive: true }));
    await expect(checkWorkspacePackage(smoke, [], PAGE, async () => undefined)).rejects.toThrow('node_modules/@acme');
  });

  it('restores the app after a failed proof and keeps the proof\'s error', async () => {
    const smoke = target();
    const failure = checkWorkspacePackage(smoke, [], PAGE, async (app) => {
      writeFileSync(join(app.app, 'package.json'), '{"changed":true}\n');
      throw new SmokeError('the proof failed here');
    });
    await expect(failure).rejects.toThrow('the proof failed here');
    expect(readFileSync(join(smoke.app, 'package.json'), 'utf8')).toBe('{"name":"app"}\n');
  });

  it('attaches a failing restore to the proof\'s error, which stays the first line', async () => {
    const smoke = target((app) => writeFileSync(join(app, 'left.txt'), 'x'));
    const error = (await checkWorkspacePackage(smoke, [], PAGE, async () => {
      throw new SmokeError('the proof failed here');
    }).catch((caught: Error) => caught)) as Error;
    expect(error.message.split('\n')[0]).toBe('the proof failed here');
    expect(error.message).toContain('and restoring the app failed too: the app is not as it was before the workspace package: left.txt');
  });
});
