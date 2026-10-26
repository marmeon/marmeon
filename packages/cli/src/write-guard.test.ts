import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KeyGenerateCommand } from './commands/key-generate.ts';
import { MakeDockerCommand } from './commands/make-docker.ts';
import { MakeLintConfigCommand } from './commands/make-lint-config.ts';
import { MakeJobCommand, MakeModuleCommand, MakeEventCommand } from './commands/make.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

function project(): { root: string; outside: string } {
  const outside = realpathSync(tempDir('marmeon-write-guard-outside-'));
  writeFileSync(join(outside, 'kept.txt'), 'untouched');
  return { root: realpathSync(tempDir('marmeon-write-guard-')), outside };
}

function input(root: string, args: string[] = [], options: Record<string, unknown> = {}) {
  const errors: string[] = [];
  const quiet = () => {};
  const output = { success: quiet, info: quiet, warn: quiet, line: quiet, error: (line: string) => errors.push(line) };
  return { input: { root, args, options, output, spawn: async () => 0 } as never, errors };
}

/** The outside directory must hold the one file it started with. */
function untouched(outside: string): void {
  expect(readdirSync(outside)).toEqual(['kept.txt']);
  expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('untouched');
}

describe('generators and links out of the project', () => {
  it('make:event writes nothing through a link in its module', async () => {
    const { root, outside } = project();
    mkdirSync(join(root, 'modules/shop'), { recursive: true });
    symlinkSync(outside, join(root, 'modules/shop/events'), 'dir');
    const { input: given, errors } = input(root, ['OrderShipped'], { module: 'shop', force: true });
    expect(await new MakeEventCommand().handle(given)).toBe(1);
    expect(errors).toEqual(['modules/shop/events leads out of the project, and the command would write through it. Replace the link with a real file or directory. Nothing was written.']);
    untouched(outside);
  });

  it('make:job does not register through a module entry that is a link out', async () => {
    const { root, outside } = project();
    mkdirSync(join(root, 'modules/shop'), { recursive: true });
    writeFileSync(join(outside, 'index.ts'), 'untouched');
    symlinkSync(join(outside, 'index.ts'), join(root, 'modules/shop/index.ts'));
    const { input: given, errors } = input(root, ['SendReport'], { module: 'shop' });
    expect(await new MakeJobCommand().handle(given)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('modules/shop/index.ts leads out of the project');
    expect(readFileSync(join(outside, 'index.ts'), 'utf8')).toBe('untouched');
    expect(existsSync(join(root, 'modules/shop/jobs'))).toBe(false);
  });

  it('make:module writes nothing when bootstrap/app.ts is a link out', () => {
    const { root, outside } = project();
    mkdirSync(join(root, 'bootstrap'));
    symlinkSync(join(outside, 'kept.txt'), join(root, 'bootstrap/app.ts'));
    const { input: given, errors } = input(root, ['billing']);
    expect(new MakeModuleCommand().handle(given)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('bootstrap/app.ts leads out of the project');
    expect(existsSync(join(root, 'modules'))).toBe(false);
    untouched(outside);
  });

  it('make:event still writes through a link that stays inside the project', async () => {
    const { root } = project();
    mkdirSync(join(root, 'modules/shop'), { recursive: true });
    mkdirSync(join(root, 'shared-events'));
    symlinkSync(join(root, 'shared-events'), join(root, 'modules/shop/events'), 'dir');
    expect(await new MakeEventCommand().handle(input(root, ['OrderShipped'], { module: 'shop' }).input)).toBe(0);
    expect(existsSync(join(root, 'shared-events/OrderShipped.ts'))).toBe(true);
  });

  it('make:lint-config refuses a .oxlintrc.json that is a link out, even with --force', () => {
    const { root, outside } = project();
    symlinkSync(join(outside, 'kept.txt'), join(root, '.oxlintrc.json'));
    const { input: given, errors } = input(root, [], { force: true });
    expect(new MakeLintConfigCommand().handle(given)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('.oxlintrc.json leads out of the project');
    untouched(outside);
  });

  it('make:docker refuses when any of its files is a link out, and writes none of them', () => {
    const { root, outside } = project();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { '@marmeon/core': '1.0.0' } }));
    writeFileSync(join(root, 'package-lock.json'), '{}');
    symlinkSync(join(outside, 'kept.txt'), join(root, 'compose.production.yaml'));
    const { input: given, errors } = input(root, [], { force: true });
    expect(new MakeDockerCommand().handle(given)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('compose.production.yaml leads out of the project');
    expect(existsSync(join(root, 'Dockerfile'))).toBe(false);
    untouched(outside);
  });

  it('key:generate refuses a .env that is a link out, even with --force', () => {
    const { root, outside } = project();
    symlinkSync(join(outside, 'kept.txt'), join(root, '.env'));
    const { input: given, errors } = input(root, [], { force: true });
    expect(new KeyGenerateCommand().handle(given)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('.env leads out of the project');
    untouched(outside);
  });

  it('key:generate still writes through a .env that links inside the project', () => {
    const { root } = project();
    writeFileSync(join(root, 'real.env'), '');
    symlinkSync(join(root, 'real.env'), join(root, '.env'));
    expect(new KeyGenerateCommand().handle(input(root).input)).toBe(0);
    expect(readFileSync(join(root, 'real.env'), 'utf8')).toMatch(/^APP_KEY=/m);
  });
});
