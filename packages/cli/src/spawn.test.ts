import { describe, expect, it } from 'vitest';
import { lineBuffer } from './spawn.ts';

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
