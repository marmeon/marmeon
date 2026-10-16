import { describe, expect, it } from 'vitest';
import type { CommandClass } from './command.ts';
import { printCommandHelp, printCommandList } from './commands/list.ts';
import type { Output } from './output.ts';

const lines: string[] = [];
const output = { line: (text = '') => void lines.push(text) } as unknown as Output;
const command = (name: string, experimental?: boolean) =>
  ({ command: name, description: `Runs ${name}.`, ...(experimental === undefined ? {} : { experimental }) }) as unknown as CommandClass;

describe('experimental commands', () => {
  it('marks them in marmeon list, and only them', () => {
    lines.length = 0;
    printCommandList({ output }, [command('probe', true), command('steady'), command('other', false)]);
    expect(lines.find((line) => line.includes('probe'))).toContain('(experimental)');
    expect(lines.find((line) => line.includes('steady'))).not.toContain('experimental');
    expect(lines.find((line) => line.includes('other'))).not.toContain('experimental');
  });

  it('marks them in --help', () => {
    lines.length = 0;
    printCommandHelp({ output }, command('probe', true));
    expect(lines[0]).toBe('Runs probe. (experimental)');
    lines.length = 0;
    printCommandHelp({ output }, command('steady'));
    expect(lines[0]).toBe('Runs steady.');
  });
});
