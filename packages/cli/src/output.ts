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

/** Console output for commands. Colours are dropped automatically when not writing to a terminal. */
export class Output {
  line(text = ''): void {
    process.stdout.write(`${text}\n`);
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
