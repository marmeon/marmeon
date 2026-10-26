import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CommandClass } from './command.ts';
import { printCommandHelp, printCommandList, printCommandListJson } from './commands/list.ts';
import { Output } from './output.ts';

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

describe('marmeon list', () => {
  it('shows start and dev once, even when a command has the name', () => {
    lines.length = 0;
    printCommandList({ output }, [command('start'), command('dev'), command('other')]);
    expect(lines.filter((line) => /^\s*start\s/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^\s*dev\s/.test(line))).toHaveLength(1);
  });
});

describe('list --json', () => {
  const options = { json: { type: 'boolean', short: 'j', default: false } };
  const alpha = { ...command('alpha'), usage: '<Name>', options } as unknown as CommandClass;
  const hidden = { ...command('secret'), hidden: true } as unknown as CommandClass;

  function print(...args: [boolean?, string[]?]): string {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    printCommandListJson({ output: new Output() }, [command('probe', true), alpha, hidden], ...args);
    write.mockRestore();
    return written.join('');
  }

  it('prints one document with the format first, matching the stored format, without hidden commands', () => {
    const out = print();
    const document = JSON.parse(out) as { commands: { name: string }[] };
    expect(Object.keys(document)[0]).toBe('format');
    expect(document.commands.map((entry) => entry.name)).not.toContain('secret');
    expect(document).toMatchObject(JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-list/v1.json', import.meta.url), 'utf8')));
  });

  it('lists each command once, the launcher’s too', () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    printCommandListJson({ output: new Output() }, [command('start'), command('dev'), alpha]);
    write.mockRestore();
    const names = (JSON.parse(written.join('')) as { commands: { name: string }[] }).commands.map((entry) => entry.name);
    expect(names.filter((name) => name === 'start')).toHaveLength(1);
    expect(names.filter((name) => name === 'dev')).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('says when the list is incomplete', () => {
    expect(JSON.parse(print(false, ['App did not load']))).toMatchObject({ complete: false, warnings: ['App did not load'] });
  });
});
