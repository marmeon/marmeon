import { styleText } from 'node:util';
import { ConfigError, type Redactor } from '@marmeon/core';

type Style = Parameters<typeof styleText>[0];

/**
 * What a command prints with `--json`: one object whose first key, `format`, names the version of the document. See
 * docs/console.md#machine-readable-output.
 */
export interface JsonDocument {
  readonly format: number;
  readonly [key: string]: unknown;
}

/**
 * Sends everything that writes to stdout (`process.stdout.write`, `console.log`, `console.info`, `console.debug`) to stderr, so that
 * with `--json` stdout holds the document and nothing else, whatever app code logs. `write` is the original writer, for the one
 * `Output` of the running command; any other `Output` is redirected too. `restore` undoes it.
 */
export function stdoutToStderr(): { readonly restore: () => void; readonly write: (text: string) => void } {
  const original = process.stdout.write;
  const methods = { log: console.log, info: console.info, debug: console.debug };
  process.stdout.write = ((...args: Parameters<typeof process.stderr.write>) => process.stderr.write(...args)) as typeof process.stdout.write;
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = console.info = console.debug = toStderr;
  return {
    write: (text) => void original.call(process.stdout, text),
    restore: () => {
      process.stdout.write = original;
      Object.assign(console, methods);
    },
  };
}

/** The writers of the `Output`s that were given one: kept outside the class, so the class stays what its structure says (commands of other packages take an `Output`-shaped value). */
const writers = new WeakMap<object, (text: string) => void>();

/**
 * @internal The writer that reaches the original stdout for `output`, or `process.stdout.write` when it was given none: what
 * `marmeon mcp` writes its protocol frames with while everything else is kept off stdout. Not exported from the package.
 */
export function rawWriter(output: Output): (text: string) => void {
  return writers.get(output) ?? ((text) => void process.stdout.write(text));
}

/**
 * @internal `text` with every control, format and separator character written as `\uXXXX` (per UTF-16 unit, so the notation is also
 * a valid JSON escape), except line feeds, tabs, the zero-width joiners and colour sequences (SGR) that do not conceal. A caller embeds `style()` colours in the
 * text, so the colours must survive; an OSC, a cursor move, a carriage return or a hidden-text sequence in someone else's value must not.
 */
export function terminalText(text: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what it writes out
  return text.replace(/\x1b\[([0-9;]*)m|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (match, parameters: string | undefined) => {
    if (parameters !== undefined && !parameters.split(';').some((parameter) => parameter !== '' && Number(parameter) === 8)) return match;
    // The joiners shape Persian, Indic and emoji text; every other format character (bidi controls included) is written out.
    if (match === '\n' || match === '\t' || match === '\u200c' || match === '\u200d') return match;
    // A concealing colour sequence loses only its escape: the rest reads as text.
    const [written, rest] = parameters === undefined ? [match, ''] : ['\x1b', match.slice(1)];
    let escaped = '';
    for (let i = 0; i < written.length; i++) escaped += `\\u${written.charCodeAt(i).toString(16).padStart(4, '0')}`;
    return escaped + rest;
  });
}

/**
 * Console output for commands. Colours are dropped automatically when not writing to a terminal. Control characters in the text are
 * written out (`\u001b`), colours stay: see docs/console.md#writing-commands. Given to a command and not meant to be implemented — tests use `app.command()`.
 */
export class Output {
  /** @internal `write` replaces `process.stdout.write` as the way to stdout: `run()` gives its own `Output` the original one while the process is kept off stdout. */
  constructor(write?: (text: string) => void) {
    if (write) writers.set(this, write);
  }

  line(text = ''): void {
    const write = writers.get(this);
    if (write) write(`${terminalText(text)}\n`);
    else process.stdout.write(`${terminalText(text)}\n`);
  }
  info(text: string): void {
    this.line(`${style('cyan', 'ℹ')} ${text}`);
  }
  success(text: string): void {
    this.line(`${style('green', '✓')} ${text}`);
  }
  warn(text: string): void {
    process.stderr.write(`${style('yellow', '!')} ${terminalText(text)}\n`);
  }
  error(text: string): void {
    process.stderr.write(`${style('red', '✗')} ${terminalText(text)}\n`);
  }
  /** Prints `document` as the only thing on stdout, `format` first. The one way a command writes `--json`. */
  json(document: JsonDocument): void {
    const { format, ...rest } = document;
    this.line(JSON.stringify({ format, ...rest }, null, 2));
  }
  /** Aligned columns; the header row is dimmed. A row that is a string is a note: printed as it is under the row before, outside the column widths. */
  table(header: readonly string[], rows: readonly (readonly string[] | string)[]): void {
    header = header.map(terminalText);
    rows = rows.map((row) => (typeof row === 'string' ? row : row.map(terminalText)));
    const cells = rows.filter((row): row is readonly string[] => typeof row !== 'string');
    const widths = header.map((cell, i) => Math.max(cell.length, ...cells.map((row) => row[i] ?? '').map((cell) => cell.length)));
    const format = (row: readonly string[]) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd();
    this.line(style('dim', format(header)));
    for (const row of rows) this.line(typeof row === 'string' ? row : format(row));
  }
}

export function style(format: Style, text: string): string {
  return styleText(format, text, { stream: process.stdout });
}

/**
 * A failed command: its error and where it came from — not Node's dump of every property of every cause. The text is masked with
 * `redactor` (a message may quote a secret) and, like all output, written without control characters.
 */
export function printError(output: Output, error: unknown, redactor: Redactor): void {
  if (!(error instanceof Error)) {
    output.error(redactor.text(String(error)));
    return;
  }
  // A refusal that names its own fix (a configuration or a path to change): the message, no frames.
  if (error instanceof ConfigError) {
    output.error(redactor.text(error.message));
    return;
  }
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line) && !line.includes('node:internal'));
  // Continuation lines of the message are indented: a line break in it cannot start a line that looks like another message.
  const message = `${error.name}: ${error.message}`.replaceAll('\n', '\n  ');
  output.error(redactor.text([message, ...frames.slice(0, 5).map((frame) => `  ${frame.trim()}`)].join('\n')));
}
