import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KeyGenerateCommand } from './commands/key-generate.ts';
import { MakeDockerCommand } from './commands/make-docker.ts';
import { MakeLintConfigCommand } from './commands/make-lint-config.ts';
import { leavesProject, writeProjectFile } from './write-guard.ts';
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

describe('a link to nothing at the name of a generated file', () => {
  /** `root/d -> ../outside/sub` and `root/evil -> d/../x`: the write would create `outside/sub/../x`, i.e. `outside/x`. */
  function dangling(): { root: string; outside: string } {
    const { root, outside } = project();
    mkdirSync(join(outside, 'sub'));
    symlinkSync(join(outside, 'sub'), join(root, 'd'), 'dir');
    return { root, outside };
  }

  it('make:event refuses a target that is a link to nothing outside the project', async () => {
    const { root, outside } = dangling();
    mkdirSync(join(root, 'modules/shop/events'), { recursive: true });
    symlinkSync('../../../d/../OrderShipped.ts', join(root, 'modules/shop/events/OrderShipped.ts'));
    const { input: given, errors } = input(root, ['OrderShipped'], { module: 'shop', force: true });
    expect(await new MakeEventCommand().handle(given)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('modules/shop/events/OrderShipped.ts leads out of the project');
    expect(existsSync(join(outside, 'OrderShipped.ts'))).toBe(false);
  });

  it('make:event refuses a link to nothing whose target lies inside the project, too', async () => {
    const { root } = project();
    mkdirSync(join(root, 'modules/shop/events'), { recursive: true });
    symlinkSync(join(root, 'elsewhere.ts'), join(root, 'modules/shop/events/OrderShipped.ts'));
    const { input: given, errors } = input(root, ['OrderShipped'], { module: 'shop', force: true });
    expect(await new MakeEventCommand().handle(given)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('modules/shop/events/OrderShipped.ts is a link to nothing');
    expect(existsSync(join(root, 'elsewhere.ts'))).toBe(false);
  });
});

describe('writeProjectFile', () => {
  it('creates a new file and its folders, and overwrites an existing one', () => {
    const { root } = project();
    const file = join(root, 'a/b/c.txt');
    writeProjectFile(file, 'one');
    expect(readFileSync(file, 'utf8')).toBe('one');
    writeProjectFile(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
  });

  it('fails with EEXIST on a link to nothing at the name, and creates nothing behind it', () => {
    const { root, outside } = project();
    symlinkSync(join(outside, 'new.txt'), join(root, 'link.txt'));
    expect(() => writeProjectFile(join(root, 'link.txt'), 'x')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('refuses to overwrite a file that became a link, and writes nothing outside', () => {
    const { root, outside } = project();
    writeProjectFile(join(root, 'a.txt'), 'one');
    rmSync(join(root, 'a.txt'));
    symlinkSync(join(outside, 'kept.txt'), join(root, 'a.txt'));
    expect(() => writeProjectFile(join(root, 'a.txt'), 'two')).toThrow(/A link at the name/);
    untouched(outside);
  });

  it('refuses to overwrite a file with another hard link, and leaves its content', () => {
    const { root, outside } = project();
    linkSync(join(outside, 'kept.txt'), join(root, 'a.txt'));
    expect(() => writeProjectFile(join(root, 'a.txt'), 'two')).toThrow(/hard link/);
    untouched(outside);
  });
});

describe('--force and a link inside the project', () => {
  it('make:docker --force writes none of its files when one of them is a link', () => {
    const { root } = project();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { '@marmeon/core': '1.0.0' } }));
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'Dockerfile'), 'mine');
    writeFileSync(join(root, 'real.ignore'), 'mine');
    symlinkSync(join(root, 'real.ignore'), join(root, '.dockerignore'));
    const { input: given, errors } = input(root, [], { force: true });
    expect(new MakeDockerCommand().handle(given)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('.dockerignore is a link');
    expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).toBe('mine');
    expect(existsSync(join(root, 'compose.production.yaml'))).toBe(false);
  });
});

describe('leavesProject below a regular file', () => {
  it('does not throw when a parent of the file is a file', () => {
    const { root } = project();
    writeFileSync(join(root, 'file'), 'x');
    const { input: given, errors } = input(root);
    expect(leavesProject(given, [join(root, 'file/sub.txt')])).toBe(false);
    expect(errors).toEqual([]);
  });
});
