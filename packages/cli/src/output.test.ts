import { afterEach, describe, expect, it, vi } from 'vitest';
import { Output, rawWriter, terminalText } from './output.ts';

const OSC_52 = '\x1b]52;c;aGk=\x07';
const hostile = `a${OSC_52}b\x1b[2Kc\rd\u202ee\x9bf`;

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => void stdout.push(text)) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => void stderr.push(text)) as never);
  return { stdout, stderr };
}

/** No control character the terminal would act on is left; `\n` and `\t` are the only plain ones, and SGR colours are checked on their own. */
function expectWrittenOut(text: string): void {
  // oxlint-disable-next-line no-control-regex -- control characters are what the test looks for
  expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/);
  expect(text).toContain('\\u001b]52;c;aGk=\\u0007');
  expect(text).toContain('\\u001b[2K');
  expect(text).toContain('\\u000d');
  expect(text).toContain('\\u202e');
  expect(text).toContain('\\u009b');
}

afterEach(() => vi.restoreAllMocks());

describe('Output writes control characters out', () => {
  it('in line, info and success', () => {
    const { stdout } = capture();
    const output = new Output();
    output.line(hostile);
    output.info(hostile);
    output.success(hostile);
    expect(stdout).toHaveLength(3);
    for (const text of stdout) expectWrittenOut(text);
  });

  it('in warn and error', () => {
    const { stderr } = capture();
    const output = new Output();
    output.warn(hostile);
    output.error(hostile);
    expect(stderr).toHaveLength(2);
    for (const text of stderr) expectWrittenOut(text);
  });

  it('in the cells and notes of a table, and sizes the columns by the written-out text', () => {
    const { stdout } = capture();
    new Output().table(['name', 'x\x1b[2K'], [['a\rb', 'c'], ['dd', 'e'], 'note\x07']);
    const text = stdout.join('');
    // oxlint-disable-next-line no-control-regex -- control characters are what the test looks for
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(text).toContain('a\\u000db  c');
    expect(text).toContain('note\\u0007');
    const [header] = text.split('\n');
    expect(header).toContain('x\\u001b[2K');
  });

  it('through the writer an Output was given, while rawWriter hands that writer out untouched', () => {
    const written: string[] = [];
    const output = new Output((text) => void written.push(text));
    output.line(hostile);
    expectWrittenOut(written.join(''));
    written.length = 0;
    rawWriter(output)('frame\x1b\n');
    expect(written).toEqual(['frame\x1b\n']);
  });

  it('but keeps line feeds, tabs and colours', () => {
    const { stdout } = capture();
    new Output().line('\x1b[32mok\x1b[39m\there\nnext \x1b[1;4mbold\x1b[0m \x1b[m');
    expect(stdout.join('')).toBe('\x1b[32mok\x1b[39m\there\nnext \x1b[1;4mbold\x1b[0m \x1b[m\n');
  });

  it('writes out a colour sequence that hides text, however it is written', () => {
    for (const hide of ['\x1b[8m', '\x1b[1;8m', '\x1b[08m', '\x1b[31;8;4m']) expect(terminalText(`a${hide}b`)).toBe(`a\\u001b${hide.slice(1)}b`);
  });

  it('writes out what a colour sequence cannot be: other CSI, a colour with a colon, an unterminated one', () => {
    expect(terminalText('\x1b[2J\x1b[38:2::1:2:3m\x1b[31')).toBe('\\u001b[2J\\u001b[38:2::1:2:3m\\u001b[31');
  });

  it('keeps the joiners of Persian and emoji text, and writes out every bidi control', () => {
    expect(terminalText('می\u200cخواهم 👩\u200d💻')).toBe('می\u200cخواهم 👩\u200d💻');
    for (const code of [0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(terminalText(String.fromCharCode(code))).toBe(`\\u${code.toString(16).padStart(4, '0')}`);
    }
  });

  it('writes an astral format character as a surrogate pair, which is a JSON escape too', () => {
    expect(terminalText('\u{e0001}')).toBe('\\udb40\\udc01');
  });

  it('keeps json() a document that parses to the original', () => {
    const { stdout } = capture();
    const value = `a\u202eb\u{e0001}c\x9bd\x7fe\u2028f`;
    new Output().json({ format: 1, value });
    expect(stdout.join('')).not.toMatch(/[\u202e\x9b\x7f\u2028]/u);
    expect(JSON.parse(stdout.join(''))).toEqual({ format: 1, value });
  });
});
