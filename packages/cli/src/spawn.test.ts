import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { lineBuffer, runMarmeonJson } from './spawn.ts';

describe('lineBuffer', () => {
  it('passes on complete lines only, joins a line split across chunks and flushes the rest', () => {
    const lines: string[] = [];
    const buffer = lineBuffer((line) => lines.push(line));
    buffer.write('first\nsec');
    expect(lines).toEqual(['first']);
    buffer.write('ond\nthi');
    expect(lines).toEqual(['first', 'second']);
    buffer.write('rd');
    buffer.flush();
    expect(lines).toEqual(['first', 'second', 'third']);
    buffer.flush();
    expect(lines).toHaveLength(3);
  });
});

describe('runMarmeonJson and standard input', () => {
  // A stand-in for the launcher that prints what it got on stdin, and its arguments, as one JSON document.
  const echo = () => {
    const dir = tempDir('marmeon-spawn-input-');
    const launcher = join(dir, 'launcher.mjs');
    writeFileSync(launcher, "let text = ''; process.stdin.setEncoding('utf8').on('data', (c) => (text += c)).on('end', () => console.log(JSON.stringify({ text, args: process.argv.slice(2) })));\n");
    return { dir, launcher };
  };

  it('hands the input to the child as its whole standard input', async () => {
    const { dir, launcher } = echo();
    const input = "select 1;\n-- --database=x \"; rm -rf / ü\n";
    const run = await runMarmeonJson(dir, ['one'], { timeoutMs: 10_000, maxStdoutBytes: 1024 * 1024, launcher, input });
    expect(run.document).toEqual({ text: input, args: ['one'] });
  });

  it('closes standard input when there is no input, as before', async () => {
    const { dir, launcher } = echo();
    const run = await runMarmeonJson(dir, [], { timeoutMs: 10_000, maxStdoutBytes: 1024 * 1024, launcher });
    expect(run.document).toEqual({ text: '', args: [] });
  });

  it('is no error when the child ends without reading its input', async () => {
    const dir = tempDir('marmeon-spawn-input-');
    const launcher = join(dir, 'launcher.mjs');
    writeFileSync(launcher, 'process.exit(3);\n');
    const run = await runMarmeonJson(dir, [], { timeoutMs: 10_000, maxStdoutBytes: 1024, launcher, input: 'x'.repeat(1024 * 1024) });
    expect(run.code).toBe(3);
  });
});
