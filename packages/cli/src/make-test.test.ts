import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { BUILT_IN } from './built-in.ts';
import type { CommandInput } from './command.ts';
import { MakeTestCommand } from './commands/make.ts';

function app(): string {
  const root = tempDir('marmeon-make-test-');
  mkdirSync(join(root, 'modules', 'shop'), { recursive: true });
  return root;
}

function run(root: string, args: string[], options: Record<string, unknown> = { module: 'shop' }) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const code = new MakeTestCommand().handle({ root, args, options, output } as unknown as CommandInput);
  return { code, lines: lines.map((line) => stripVTControlCharacters(line)) };
}

describe('make:test', () => {
  it('is a built-in command that does not boot the app', () => {
    expect(BUILT_IN).toContain(MakeTestCommand);
    expect(MakeTestCommand.command).toBe('make:test');
    expect(MakeTestCommand.boots).toBe(false);
  });

  it('writes a test that boots the app and expects the module path to answer 200', () => {
    const root = app();
    const { code, lines } = run(root, ['checkout-flow']);
    expect(code).toBe(0);
    const source = readFileSync(join(root, 'modules/shop/checkout-flow.test.ts'), 'utf8');
    expect(source).toContain("import { createTestApp, type TestApp } from '@marmeon/testing';");
    expect(source).toContain("import application from '../../bootstrap/app.ts';");
    expect(source).toContain("createTestApp(application, { database: 'refresh' })");
    expect(source).toContain("describe('checkout flow', { timeout: 30_000 }, () => {");
    expect(source).toContain("it('answers /shop', async () => {");
    expect(source).toContain("await app.get('/shop').assertOk();");
    expect(source).not.toMatch(/it\.todo|it\.skip/);
    expect(lines.join('\n')).toContain('The test fails until /shop answers 200 — change it to what you test.');
    expect(lines.join('\n')).toContain('docs/http-tests.md');
  });

  it('takes the path from --path', () => {
    const root = app();
    expect(run(root, ['cart'], { module: 'shop', path: '/shop/carts/:id' }).code).toBe(0);
    const source = readFileSync(join(root, 'modules/shop/cart.test.ts'), 'utf8');
    expect(source).toContain("await app.get('/shop/carts/:id').assertOk();");
  });

  it.each(["/a'); evil(); ('", '/a b', 'shop', '', '/a?x=1', '/a#b', '/a\\b', '/a`b', '/${x}', '/a\nb', '/a b'])('refuses the path %j and writes nothing', (path) => {
    const root = app();
    expect(run(root, ['cart'], { module: 'shop', path }).code).toBe(1);
    expect(readdirSync(join(root, 'modules/shop'))).toEqual([]);
  });

  it.each(['Cart', 'cart_flow', '../cart', 'a--b', '-a', "a'b", ''])('refuses the name %j and writes nothing', (name) => {
    const root = app();
    expect(run(root, name === '' ? [] : [name]).code).toBe(1);
    expect(readdirSync(join(root, 'modules/shop'))).toEqual([]);
    expect(existsSync(join(root, 'modules/cart'))).toBe(false);
  });

  it('refuses an existing file without --force and overwrites with it', () => {
    const root = app();
    const file = join(root, 'modules/shop/cart.test.ts');
    writeFileSync(file, 'mine');
    const again = run(root, ['cart']);
    expect([again.code, again.lines.join('\n')]).toEqual([1, expect.stringContaining('already exists (use --force to overwrite)')]);
    expect(readFileSync(file, 'utf8')).toBe('mine');
    expect(run(root, ['cart'], { module: 'shop', force: true }).code).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('assertOk');
  });

  it('needs an existing module', () => {
    const root = app();
    const { code, lines } = run(root, ['cart'], { module: 'cart' });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Module "cart" does not exist');
    expect(run(root, ['cart'], {}).code).toBe(1);
    expect(existsSync(join(root, 'modules/cart'))).toBe(false);
  });
});
