import type { Redactor, Solution } from '@marmeon/core';
import { parseStack, withSnippets } from './report.ts';

/** Vite's error payload (`hot.send({ type: 'error', err })`) — what its overlay shows. */
export interface OverlayError {
  message: string;
  stack: string;
  id?: string;
  frame?: string;
  plugin?: string;
  loc?: { file: string; line: number; column: number };
}

/**
 * A server-rendering error for Vite's overlay: the message with its solutions, the stack (already mapped to the
 * sources by `ssrFixStacktrace`), and — for the first frame in the app's code — a code frame and a link (`loc`), as Vite
 * shows its own transform errors. Redacted like the error page.
 */
export function overlayError(error: unknown, root: string, redactor: Redactor, solutions: readonly Solution[] = []): OverlayError {
  const failure = error instanceof Error ? error : new Error(String(error));
  const frames = parseStack(failure.stack ?? '', root);
  const target = frames.find((frame) => frame.app) ?? frames.find((frame) => !frame.internal);
  const [located] = target ? withSnippets([target], 2) : [];
  const hints = solutions.map((solution) => `\n\n${solution.title}: ${solution.text}${solution.command ? `\n  $ ${solution.command}` : ''}`).join('');
  const message = `[${failure.name}] ${failure.message}\nServer rendering failed — the browser renders this page instead.${hints}`;
  return {
    message: redactor.text(message),
    stack: redactor.text(failure.stack ?? ''),
    plugin: 'marmeon:ssr',
    ...(located ? { id: located.file, loc: { file: located.file, line: located.line, column: located.column } } : {}),
    ...(located?.snippet ? { frame: codeFrame(located.snippet, located.column) } : {}),
  };
}

/** A code frame like Vite's: the lines with their numbers, a caret under the column of the current one. */
export function codeFrame(lines: readonly { number: number; text: string; current: boolean }[], column: number): string {
  const width = String(lines.at(-1)?.number ?? 0).length;
  const out: string[] = [];
  for (const line of lines) {
    out.push(`${String(line.number).padStart(width)} | ${line.text}`);
    if (line.current) out.push(`${' '.repeat(width)} | ${' '.repeat(Math.max(0, column - 1))}^`);
  }
  return out.join('\n');
}

/**
 * The script that shows `error` in Vite's overlay as soon as the document loads — Vite only buffers an error for a tab when
 * no tab is connected at all, so the document that failed brings its own (the overlay replaces an earlier one).
 */
export function overlayScript(error: OverlayError, nonce?: string): string {
  const payload = JSON.stringify(error).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  // The response's CSP nonce: under `contentSecurityPolicy()` an inline script runs only with it.
  return `<script type="module"${nonce ? ` nonce="${nonce}"` : ''}>import('/@vite/client').then(({ ErrorOverlay }) => { document.querySelector('vite-error-overlay')?.remove(); document.body.appendChild(new ErrorOverlay(${payload})); });</script>`;
}
