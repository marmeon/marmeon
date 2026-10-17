import { styleText } from 'node:util';

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

/** Console output for commands. Colours are dropped automatically when not writing to a terminal. */
export class Output {
  /** `write` replaces `process.stdout.write` as the way to stdout: `run()` gives its own `Output` the original one while the process is kept off stdout. */
  constructor(write?: (text: string) => void) {
    if (write) writers.set(this, write);
  }

  line(text = ''): void {
    const write = writers.get(this);
    if (write) write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
  }
  info(text: string): void {
    this.line(`${style('cyan', 'ℹ')} ${text}`);
  }
  success(text: string): void {
    this.line(`${style('green', '✓')} ${text}`);
  }
  warn(text: string): void {
    process.stderr.write(`${style('yellow', '!')} ${text}\n`);
  }
  error(text: string): void {
    process.stderr.write(`${style('red', '✗')} ${text}\n`);
  }
  /** Prints `document` as the only thing on stdout, `format` first. The one way a command writes `--json`. */
  json(document: JsonDocument): void {
    const { format, ...rest } = document;
    this.line(JSON.stringify({ format, ...rest }, null, 2));
  }
  /** Aligned columns; the header row is dimmed. */
  table(header: readonly string[], rows: readonly (readonly string[])[]): void {
    const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => (row[i] ?? '').length)));
    const format = (row: readonly string[]) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd();
    this.line(style('dim', format(header)));
    for (const row of rows) this.line(format(row));
  }
}

export function style(format: Style, text: string): string {
  return styleText(format, text, { stream: process.stdout });
}
