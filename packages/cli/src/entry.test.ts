import * as core from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import * as cli from './index.ts';
import * as internal from './internal.ts';
import * as main from './main.ts';

describe('the entry points of the CLI', () => {
  it('keeps what an app and a package document in the main entry', () => {
    for (const name of ['CliServiceProvider', 'DevProcesses', 'Output', 'CommandSetupError', 'CommandArgumentsError']) expect(cli, name).toHaveProperty(name);
  });

  it('exports the class of the core, so an instanceof holds for a package that throws it', () => {
    expect(cli.CommandArgumentsError).toBe(core.CommandArgumentsError);
  });

  it('keeps the command registry and the runner out of the main entry and in ./internal', () => {
    for (const name of ['CommandRegistry', 'runCommand', 'spawnMarmeon']) {
      expect(cli, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });

  it('drops the argument parsing and the process helpers from every entry', () => {
    for (const name of ['parseCommandArgs', 'startMarmeon']) {
      expect(cli, name).not.toHaveProperty(name);
      expect(internal, name).not.toHaveProperty(name);
      expect(main, name).not.toHaveProperty(name);
    }
  });

  it('gives the launcher its entry: ./main runs a command', () => {
    expect(main).toHaveProperty('run');
    expect(cli).not.toHaveProperty('run');
  });
});
