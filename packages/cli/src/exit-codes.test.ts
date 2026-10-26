import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon } from './__fixtures__/cli.ts';

function app(): string {
  const root = tempDir('marmeon-exit-codes-');
  mkdirSync(join(root, 'modules', 'notes'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'exit-codes', dependencies: { marmeon: 'workspace:*' } }));
  return root;
}

// A wrong call (an argument the command refuses) ends with 2 and a message on stderr; a failure of the state — a module that is
// missing, a file that exists — ends with 1. Each case runs the real CLI, which is what a script sees.
describe('exit codes of the commands that check their own arguments', { timeout: 30_000 }, () => {
  it.each([
    ['make:module', ['Billing'], 'Pass a kebab-case name'],
    ['make:module', [], 'Pass a kebab-case name'],
    ['make:controller', ['ShowNote'], 'Pass the module: --module=<kebab-case-name>'],
    ['make:controller', ['--module=notes'], 'Pass a PascalCase name'],
    ['make:controller', ['show_note', '--module=notes'], 'Pass a PascalCase name'],
    ['make:controller', ['EditNote', '--module=notes', '--view', '--request'], '--view renders a page'],
    ['make:event', ['--module=notes'], 'Pass a PascalCase name'],
    ['make:listener', ['--module=notes'], 'Pass a PascalCase name'],
    ['make:job', ['--module=notes'], 'Pass a PascalCase name'],
    ['make:notification', ['--module=notes'], 'Pass a PascalCase name'],
    ['make:seeder', ['--module=notes'], 'Pass a PascalCase name'],
    ['make:middleware', ['--module=notes'], 'Pass a PascalCase name'],
    ['make:policy', ['--module=notes'], 'Pass a PascalCase name'],
    ['make:resource', ['bookmark'], 'Pass a PascalCase singular name'],
    ['make:resource', ['Bookmark', '--module=Not_Kebab'], 'Pass the module as --module=<kebab-case-name>'],
    ['make:docker', ['--caddy', '--nginx'], 'Choose one proxy'],
  ] as const)('%s %j exits with 2 and says why on stderr', (command, args, message) => {
    const result = marmeon(app(), [command, ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe('');
  });

  it('exits with 1 for a module that does not exist and a file that exists', () => {
    const root = app();
    const missing = marmeon(root, ['make:event', 'OrderShipped', '--module=billing']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('does not exist');
    expect(marmeon(root, ['make:event', 'OrderShipped', '--module=notes']).code).toBe(0);
    const exists = marmeon(root, ['make:event', 'OrderShipped', '--module=notes']);
    expect(exists.code).toBe(1);
    expect(exists.stderr).toContain('exists');
    expect(marmeon(root, ['make:lint-config']).code).toBe(0);
    const lint = marmeon(root, ['make:lint-config']);
    expect(lint.code).toBe(1);
    expect(lint.stderr).toContain('already exists');
  });
});
