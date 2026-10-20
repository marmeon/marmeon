import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { BUILT_IN } from './built-in.ts';
import type { CommandInput } from './command.ts';
import { MakePolicyCommand } from './commands/make.ts';

function app(manifest: string | null = JSON.stringify({ dependencies: { '@marmeon/auth': 'workspace:*' } })): string {
  const root = tempDir('marmeon-make-policy-');
  mkdirSync(join(root, 'modules', 'notes'), { recursive: true });
  if (manifest !== null) writeFileSync(join(root, 'package.json'), manifest);
  return root;
}

function run(root: string, args: string[], options: Record<string, unknown> = { module: 'notes' }) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const code = new MakePolicyCommand().handle({ root, args, options, output } as unknown as CommandInput);
  return { code, lines: lines.map((line) => stripVTControlCharacters(line)) };
}

describe('make:policy', () => {
  it('is a built-in command that does not boot the app', () => {
    expect(BUILT_IN).toContain(MakePolicyCommand);
    expect(MakePolicyCommand.command).toBe('make:policy');
    expect(MakePolicyCommand.boots).toBe(false);
  });

  it('writes a policy that allows the owner and answers everyone else with a 404', () => {
    const root = app();
    const { code, lines } = run(root, ['Note']);
    expect(code).toBe(0);
    const source = readFileSync(join(root, 'modules/notes/policies/NotePolicy.ts'), 'utf8');
    expect(source).toContain("import { denyAsNotFound, type AuthUser } from '@marmeon/auth';");
    expect(source).toContain("type Owned = { readonly user_id: AuthUser['id'] };");
    expect(source).toContain('export class NotePolicy {');
    for (const ability of ['view', 'update', 'delete']) {
      expect(source).toContain(`  ${ability}(user: AuthUser, record: Owned) {\n    return record.user_id === user.id || denyAsNotFound();\n  }\n`);
    }
    expect(source.match(/return /g)).toHaveLength(3);
    expect(source).not.toMatch(/return true|=> true|allow\(\)/);
    expect(lines.join('\n')).toContain("authorize: can(NotePolicy, 'update', '<param>')");
    expect(lines.join('\n')).toContain('docs/authorization.md#writing-policies');
  });

  it('keeps the Policy suffix once', () => {
    const root = app();
    expect(run(root, ['NotePolicy']).code).toBe(0);
    expect(existsSync(join(root, 'modules/notes/policies/NotePolicy.ts'))).toBe(true);
    expect(existsSync(join(root, 'modules/notes/policies/NotePolicyPolicy.ts'))).toBe(false);
  });

  it('refuses an existing file without --force and overwrites with it', () => {
    const root = app();
    expect(run(root, ['Note']).code).toBe(0);
    const file = join(root, 'modules/notes/policies/NotePolicy.ts');
    writeFileSync(file, 'mine');
    const again = run(root, ['Note']);
    expect([again.code, again.lines.join('\n')]).toEqual([1, expect.stringContaining('already exists (use --force to overwrite)')]);
    expect(readFileSync(file, 'utf8')).toBe('mine');
    expect(run(root, ['Note'], { module: 'notes', force: true }).code).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('denyAsNotFound');
  });

  it.each(['note', '../X', 'A-B', "A'); evil(); ('"])('refuses the name %s and writes nothing', (name) => {
    const root = app();
    expect(run(root, [name]).code).toBe(1);
    expect(existsSync(join(root, 'modules/notes/policies'))).toBe(false);
    expect(existsSync(join(root, 'modules/X'))).toBe(false);
  });

  it('needs an existing module', () => {
    const root = app();
    const { code, lines } = run(root, ['Note'], { module: 'cart' });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Module "cart" does not exist');
    expect(run(root, ['Note'], {}).code).toBe(1);
    expect(existsSync(join(root, 'modules/cart'))).toBe(false);
  });

  it.each([
    ['no package.json', null],
    ['no dependency on it', JSON.stringify({ dependencies: { '@marmeon/core': '*' } })],
    ['an unreadable package.json', 'not json'],
  ])('stops with %s for @marmeon/auth and writes nothing', (_, manifest) => {
    const root = app(manifest);
    const { code, lines } = run(root, ['Note']);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('pnpm add @marmeon/auth');
    expect(existsSync(join(root, 'modules/notes/policies'))).toBe(false);
  });

  it('accepts @marmeon/auth in devDependencies', () => {
    expect(run(app(JSON.stringify({ devDependencies: { '@marmeon/auth': '*' } })), ['Note']).code).toBe(0);
  });
});
