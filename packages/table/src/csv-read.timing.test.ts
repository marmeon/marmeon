import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { readCsv } from './csv-read.ts';

// Wall-clock and heap tests run alone (the `timing` project). The inputs are the size of the default byte limit, so a parser
// that grows a quadratic amount of work or keeps a rope of one-character strings per cell shows at once.
const MB = 1024 * 1024;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc') as () => void;

describe('the cost of reading a large CSV file', () => {
  it('reads a file of the default size in a short time', () => {
    const line = '"value one","value two",3;4,"a ""quoted"" cell"\r\n';
    const body = line.repeat(Math.floor((5 * MB - 20) / line.length));
    const bytes = utf8(`a,b,c,d\r\n${body}`);
    const started = performance.now();
    const result = readCsv(bytes, { maxRows: 200_000, delimiter: ',' });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.ok).toBe(true);
  });

  it('reads the biggest hostile shapes without a quadratic cost', () => {
    for (const bytes of [utf8('"'.repeat(5 * MB)), utf8(','.repeat(5 * MB)), utf8('\n'.repeat(5 * MB)), utf8('a\n"' + 'x'.repeat(5 * MB - 3))]) {
      const started = performance.now();
      readCsv(bytes);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });

  it('keeps about the text, not a string per character, after reading 5 MB', () => {
    // Many small cells cost an object each (about 35 MB per million); the long cells would cost 150 MB as a rope.
    const shapes: [string, number][] = [
      [('x'.repeat(520) + '\n').repeat(10_000), 20],
      [('"' + 'x'.repeat(518) + '"\n').repeat(10_000), 20],
      [('ab,'.repeat(99) + 'ab\n').repeat(Math.floor((5 * MB) / 300)), 150],
    ];
    for (const [shape, limit] of shapes) {
      const bytes = utf8(shape);
      collect();
      const before = process.memoryUsage().heapUsed;
      const result = readCsv(bytes, { maxRows: 100_000 });
      collect();
      const kept = (process.memoryUsage().heapUsed - before) / MB;
      expect(result.ok).toBe(true);
      expect(kept).toBeLessThan(limit);
    }
  });
});
