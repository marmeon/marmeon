import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { CliServiceProvider, type CommandInput } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';

class EchoCommand {
  static command = 'echo';
  static description = 'Prints what it was given';
  static options = { hours: { type: 'string' }, tag: { type: 'string', multiple: true }, force: { type: 'boolean' } } as const;
  handle({ args, options, output }: CommandInput): number {
    output.success(JSON.stringify({ args, options }));
    return 0;
  }
}

class BoomCommand {
  static command = 'boom';
  static description = 'Throws';
  handle(): never {
    throw new RangeError('it blew up');
  }
}

class NestedCommand {
  static command = 'nested';
  static description = 'Starts another marmeon';
  async handle({ spawn, output }: CommandInput): Promise<number> {
    const code = await spawn('list');
    output.line(`child exited with ${code}`);
    return code;
  }
}

const definition: ApplicationDefinition = {
  root: tempDir('marmeon-testing-command-'),
  discover: false,
  providers: [EncryptionServiceProvider, HttpServiceProvider, CliServiceProvider],
  modules: [defineModule({ name: 'commands', commands: [EchoCommand, BoomCommand, NestedCommand] })],
};

const env = { APP_KEY: generateKey() };

const echoed = (lines: readonly string[]) => JSON.parse(lines.join('\n').replace(/^✓ /, '')) as { args: string[]; options: Record<string, unknown> };

describe('app.command()', () => {
  it('turns options into flags: a number, a repeated array, a bare true, a false left out', async () => {
    const app = await createTestApp(definition, { env });
    const run = await app.command('echo', { args: ['a'], options: { hours: 2, tag: ['x', 'y'], force: true } });
    expect(run.code).toBe(0);
    expect(echoed(run.lines)).toEqual({ args: ['a'], options: { hours: '2', tag: ['x', 'y'], force: true } });
    expect(echoed((await app.command('echo', { options: { force: false } })).lines).options).toEqual({});
    await app.close();
  });

  it('hands an argument that starts with a dash over as a positional', async () => {
    const app = await createTestApp(definition, { env });
    expect(echoed((await app.command('echo', { args: ['-x', 'y'] })).lines).args).toEqual(['-x', 'y']);
    await app.close();
  });

  it('exits 2 for a flag the command does not declare, and ignores no-interaction', async () => {
    const app = await createTestApp(definition, { env });
    const wrong = await app.command('echo', { options: { nope: true } });
    expect(wrong.code).toBe(2);
    expect(wrong.lines.join('\n')).toContain('Usage: marmeon echo');
    expect((await app.command('echo', { options: { 'no-interaction': true } })).code).toBe(0);
    expect((await app.command('missing')).code).toBe(2);
    await app.close();
  });

  it('prints the help for help: true', async () => {
    const app = await createTestApp(definition, { env });
    const run = await app.command('echo', { options: { help: true } });
    expect(run.code).toBe(0);
    expect(run.lines[0]).toContain('Prints what it was given');
    await app.close();
  });

  it('returns 1 for a command that throws, with the error and where it came from', async () => {
    const app = await createTestApp(definition, { env });
    const run = await app.command('boom');
    expect(run.code).toBe(1);
    expect(run.lines[0]).toBe('✗ RangeError: it blew up');
    expect(run.lines.length).toBeGreaterThan(1);
    expect(run.lines.length).toBeLessThanOrEqual(6);
    await app.close();
  });

  it('refuses to start another marmeon in the real root', async () => {
    const app = await createTestApp(definition, { env });
    const run = await app.command('nested');
    expect(run.code).toBe(1);
    expect(run.lines[0]).toContain('A sub-command runs as its own marmeon process');
    await app.close();
  });

  it('runs a sub-command in the given root and captures its output', async () => {
    const app = await createTestApp(definition, { env });
    const run = await app.command('nested', { root: tempDir('marmeon-testing-nested-') });
    expect(run.code).toBe(0);
    expect(run.lines.join('\n')).toMatch(/make:test/);
    expect(run.lines.at(-1)).toBe('child exited with 0');
    await app.close();
  });

  it('says what is missing when the app has no CLI provider', async () => {
    const app = await createTestApp({ ...definition, providers: [EncryptionServiceProvider, HttpServiceProvider], modules: [] }, { env });
    await expect(app.command('echo')).rejects.toThrow(/CliServiceProvider/);
    await app.close();
  });
});
