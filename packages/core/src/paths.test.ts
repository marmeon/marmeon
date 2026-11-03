import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { escapesRoot, unsafeGeneratedPath } from './paths.ts';

function project(): { root: string; outside: string } {
  return { root: tempDir('marmeon-paths-'), outside: tempDir('marmeon-paths-outside-') };
}

describe('escapesRoot', () => {
  it('lets a path below the root pass, existing or not', () => {
    const { root } = project();
    mkdirSync(join(root, 'modules'));
    expect(escapesRoot(root, join(root, 'modules', 'auth', 'a.ts'))).toBeUndefined();
    expect(escapesRoot(root, 'modules/auth/a.ts')).toBeUndefined();
  });

  it('names a directory link that leads out, also for a target that does not exist yet', () => {
    const { root, outside } = project();
    mkdirSync(join(root, 'modules'));
    symlinkSync(outside, join(root, 'modules', 'auth'), 'dir');
    expect(escapesRoot(root, join(root, 'modules', 'auth', 'controllers', 'a.ts'))).toBe(join('modules', 'auth'));
  });

  it('names a file link that leads out', () => {
    const { root, outside } = project();
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(join(outside, 'secret'), join(root, '.env'));
    expect(escapesRoot(root, join(root, '.env'))).toBe('.env');
  });

  it('names a link to nowhere', () => {
    const { root, outside } = project();
    symlinkSync(join(outside, 'gone'), join(root, '.env'));
    expect(escapesRoot(root, join(root, '.env'))).toBe('.env');
  });

  it('does not throw for a path below a file; the write itself fails there', () => {
    const { root } = project();
    writeFileSync(join(root, 'plain'), 'x');
    expect(escapesRoot(root, join(root, 'plain', 'below.ts'))).toBeUndefined();
  });

  it('allows a link to nothing yet inside the project, and loops are no way out', () => {
    const { root } = project();
    symlinkSync(join(root, 'later.env'), join(root, '.env'));
    expect(escapesRoot(root, join(root, '.env'))).toBeUndefined();
    symlinkSync(join(root, 'b'), join(root, 'a'));
    symlinkSync(join(root, 'a'), join(root, 'b'));
    expect(escapesRoot(root, join(root, 'a'))).toBe('a');
  });

  it('allows a link that stays inside the project', () => {
    const { root } = project();
    mkdirSync(join(root, 'shared'));
    writeFileSync(join(root, 'shared', '.env'), 'x');
    symlinkSync(join(root, 'shared', '.env'), join(root, '.env'));
    symlinkSync(join(root, 'shared'), join(root, 'linked'), 'dir');
    expect(escapesRoot(root, join(root, '.env'))).toBeUndefined();
    expect(escapesRoot(root, join(root, 'linked', 'new.ts'))).toBeUndefined();
  });

  it('names a path that lies outside by its path', () => {
    const { root, outside } = project();
    expect(escapesRoot(root, join(outside, 'a.ts'))).toBeDefined();
    expect(escapesRoot(root, '../x.ts')).toBeDefined();
  });

  it('accepts a root that is itself reached over a link', () => {
    const { root } = project();
    const alias = join(tempDir('marmeon-paths-alias-'), 'project');
    symlinkSync(root, alias, 'dir');
    mkdirSync(join(root, 'modules'));
    expect(escapesRoot(alias, join(alias, 'modules', 'a.ts'))).toBeUndefined();
    expect(escapesRoot(root, join(alias, 'modules', 'a.ts'))).toBeUndefined();
  });
});

describe('unsafeGeneratedPath', () => {
  it('lets a missing or plain .marmeon pass, and a link that stays inside the app', () => {
    const { root } = project();
    expect(unsafeGeneratedPath(root, join(root, '.marmeon', 'schema.json'))).toBeUndefined();
    mkdirSync(join(root, 'cache'));
    symlinkSync(join(root, 'cache'), join(root, '.marmeon'), 'dir');
    expect(unsafeGeneratedPath(root, join(root, '.marmeon', 'schema.json'))).toBeUndefined();
  });

  it('names the link and the file relative to the app when .marmeon leads out', () => {
    const { root, outside } = project();
    symlinkSync(outside, join(root, '.marmeon'), 'dir');
    const message = unsafeGeneratedPath(root, join(root, '.marmeon', 'schema.json'))!;
    expect(message).toContain('.marmeon leads out of the app');
    expect(message).toContain('.marmeon/schema.json');
    expect(message).not.toContain(root);
  });

  it('does not mind a link at the file itself: the rename replaces it', () => {
    const { root, outside } = project();
    mkdirSync(join(root, '.marmeon'));
    symlinkSync(join(outside, 'x'), join(root, '.marmeon', 'schema.json'));
    expect(unsafeGeneratedPath(root, join(root, '.marmeon', 'schema.json'))).toBeUndefined();
  });
});
