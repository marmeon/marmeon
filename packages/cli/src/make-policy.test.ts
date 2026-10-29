import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { BUILT_IN } from './built-in.ts';
import { CommandArgumentsError, parseCommandArgs, type CommandInput } from './command.ts';
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
  let code: number;
  try {
    code = new MakePolicyCommand().handle({ root, args, options, output } as unknown as CommandInput);
  } catch (error) {
    // What `marmeon` does with an argument the command refuses: the message on stderr, exit 2.
    if (!(error instanceof CommandArgumentsError)) throw error;
    output.error(error.message);
    code = 2;
  }
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
    expect(run(root, [name]).code).toBe(2);
    expect(existsSync(join(root, 'modules/notes/policies'))).toBe(false);
    expect(existsSync(join(root, 'modules/X'))).toBe(false);
  });

  it('needs an existing module', () => {
    const root = app();
    const { code, lines } = run(root, ['Note'], { module: 'cart' });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Module "cart" does not exist');
    expect(run(root, ['Note'], {}).code).toBe(2);
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
    expect(lines.join('\n')).toContain('pnpm add -E @marmeon/auth@<version of your app>');
    expect(existsSync(join(root, 'modules/notes/policies'))).toBe(false);
  });

  it('accepts @marmeon/auth in devDependencies', () => {
    expect(run(app(JSON.stringify({ devDependencies: { '@marmeon/auth': '*' } })), ['Note']).code).toBe(0);
  });
});

describe('make:policy --by=role', () => {
  const byRole = { module: 'notes', by: 'role' };

  it('writes the policy and the scoped access service that look a role up once per request', () => {
    const root = app();
    const { code, lines } = run(root, ['Note'], byRole);
    expect(code).toBe(0);
    const policy = readFileSync(join(root, 'modules/notes/policies/NotePolicy.ts'), 'utf8');
    const access = readFileSync(join(root, 'modules/notes/WorkspaceAccess.ts'), 'utf8');
    expect(policy).toContain("import { WorkspaceAccess, type Role } from '../WorkspaceAccess.ts';");
    expect(policy).toContain('const ABILITIES = {');
    expect(policy).toContain('as const satisfies Record<string, readonly Role[]>');
    expect(policy).toContain('type Scoped = { readonly workspace_id: number };');
    expect(policy).toContain('this.#access.roleOf(user, record.workspace_id)');
    expect(policy).toContain('denyAsNotFound()');
    expect(policy).not.toMatch(/return true|=> true|allow\(\)/);
    expect(access).toContain("export type Role = 'admin' | 'member' | 'viewer';");
    expect(access).toContain('return new Map();');
    const text = lines.join('\n');
    expect(text).toContain('container.scoped(WorkspaceAccess);');
    expect(text).toContain("authorize: can(NotePolicy, 'update', '<param>')");
    expect(text).toContain('docs/authorization.md#generating-a-policy');
  });

  it('names the access service and the record column after --tenant', () => {
    const root = app();
    expect(run(root, ['Event'], { ...byRole, tenant: 'team_space' }).code).toBe(0);
    expect(readFileSync(join(root, 'modules/notes/policies/EventPolicy.ts'), 'utf8')).toContain('record.team_space_id');
    expect(existsSync(join(root, 'modules/notes/TeamSpaceAccess.ts'))).toBe(true);
  });

  it('keeps the access service the app filled in, also with --force', () => {
    const root = app();
    expect(run(root, ['Note'], byRole).code).toBe(0);
    const file = join(root, 'modules/notes/WorkspaceAccess.ts');
    writeFileSync(file, 'mine');
    expect(run(root, ['Event'], byRole).code).toBe(0);
    expect(run(root, ['Note'], { ...byRole, force: true }).code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('mine');
  });

  it('refuses an existing policy without --force and writes no access service', () => {
    const root = app();
    mkdirSync(join(root, 'modules/notes/policies'));
    writeFileSync(join(root, 'modules/notes/policies/NotePolicy.ts'), 'mine');
    const { code, lines } = run(root, ['Note'], byRole);
    expect([code, lines.join('\n')]).toEqual([1, expect.stringContaining('already exists')]);
    expect(existsSync(join(root, 'modules/notes/WorkspaceAccess.ts'))).toBe(false);
  });

  it.each([
    ['--by without a value', { module: 'notes', by: true }],
    ['--by with another way', { module: 'notes', by: 'owner' }],
    ['--tenant without --by', { module: 'notes', tenant: 'workspace' }],
    ['--tenant without a value', { module: 'notes', by: 'role', tenant: true }],
    ['--tenant that is no snake_case name', { module: 'notes', by: 'role', tenant: "x'; evil(); ('" }],
  ])('refuses %s and writes nothing', (_, options) => {
    const root = app();
    expect(run(root, ['Note'], options).code).toBe(2);
    expect(existsSync(join(root, 'modules/notes/policies'))).toBe(false);
  });

  it('refuses --by on the command line without a value', () => {
    expect(() => parseCommandArgs(MakePolicyCommand, ['Note', '--module=notes', '--by'])).toThrow(CommandArgumentsError);
  });

  it('says to fill in the lookup only when it wrote it', () => {
    const root = app();
    expect(run(root, ['Note'], byRole).lines.join('\n')).toContain('Fill in load()');
    const again = run(root, ['Event'], byRole).lines.join('\n');
    expect(again).not.toContain('Fill in load()');
    expect(again).toContain('never a singleton');
  });

  it('still needs @marmeon/auth', () => {
    const root = app(JSON.stringify({}));
    expect(run(root, ['Note'], byRole).code).toBe(1);
    expect(existsSync(join(root, 'modules/notes/policies'))).toBe(false);
  });
});
