import { parseSync } from './oxc.ts';

/** A string literal of a source file, as written. */
export interface StringLiteral {
  readonly value: string;
  /** 1-based line of the literal's opening quote. */
  readonly line: number;
  /** 1-based column of the literal's opening quote. */
  readonly column: number;
}

type Node = { type: string; start: number; end: number; [key: string]: any };

/**
 * Every string literal in `source` — import and export sources, `import()` and `require()` arguments, `vi.mock()` paths,
 * type positions, JSX attribute values — and every template literal without an expression, found by parsing; the file is
 * never imported. Comments are not literals, except the path of a triple-slash `<reference>`. `undefined` when the file does not parse.
 */
export function stringLiterals(source: string, filename: string): StringLiteral[] | undefined {
  const { program, errors, comments } = parseSync(filename, source);
  if (errors.length > 0) return undefined;
  const starts: number[] = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1);
  const found: StringLiteral[] = [];
  const add = (value: string, offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    found.push({ value, line: low + 1, column: offset - starts[low]! + 1 });
  };
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node !== null && typeof node === 'object') {
      const { type, value } = node as Node;
      if (type === 'Literal' && typeof value === 'string') add(value, (node as Node).start);
      else if (type === 'TemplateLiteral' && (node as Node).expressions.length === 0) add((node as Node).quasis[0]?.value.cooked ?? (node as Node).quasis[0]?.value.raw ?? '', (node as Node).start);
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }
  // `/// <reference types="…" />` names a module too, though it is a comment.
  for (const comment of (comments ?? []) as Node[]) {
    if (comment.type !== 'Line') continue;
    const reference = /^\/\s*<reference\b[^>]*?\s(?:types|path)\s*=\s*["']([^"']+)/.exec(source.slice(comment.start + 2, comment.end));
    if (reference) add(reference[1]!, comment.start + 2 + reference[0].indexOf(reference[1]!));
  }
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** A comment of a source file: its text without the comment marks, and the 1-based lines it starts and ends on. */
export interface SourceComment {
  readonly text: string;
  readonly line: number;
  readonly endLine: number;
  /** Whether only white space (or the `{` of a JSX comment) comes before it on its line. */
  readonly ownLine: boolean;
}

/** Every comment in `source`, found by parsing — so the text of a string or template is none. `undefined` when the file does not parse. */
export function sourceComments(source: string, filename: string): SourceComment[] | undefined {
  const { errors, comments } = parseSync(filename, source);
  if (errors.length > 0) return undefined;
  const lineOf = (offset: number) => {
    let line = 1;
    for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) line++;
    return line;
  };
  return ((comments ?? []) as (Node & { value: string })[]).map((comment) => ({
    text: comment.value,
    line: lineOf(comment.start),
    endLine: lineOf(Math.max(comment.start, comment.end - 1)),
    ownLine: ['', '{'].includes(source.slice(source.lastIndexOf('\n', comment.start - 1) + 1, comment.start).trim()),
  }));
}
