/**
 * What the page reports of itself to the dev server: a `console.error`, a `console.warn`, an uncaught error and an unhandled
 * rejection, as one report each on Vite's HMR channel (docs/devtools.md#browser-errors). The server checks the shape again —
 * this side sends only what it accepts, cut to its limits.
 */

/** The report a page sends: the closed shape the dev server accepts. */
export interface BrowserReport {
  readonly kind: 'console' | 'error' | 'rejection';
  readonly level: 'error' | 'warn';
  readonly message: string;
  readonly stack?: string;
  readonly source?: { readonly url: string; readonly line: number; readonly column: number };
  readonly page: string;
  readonly requestId?: string;
}

/** What {@link installBrowserLog} patches and listens on: the window (`globalThis` in a page). */
export interface BrowserLogTarget extends Pick<Window, 'addEventListener' | 'removeEventListener'> {
  readonly console: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

const MESSAGE_MAX = 4096;
const STACK_MAX = 16_384;
const URL_MAX = 2048;
/** Reports at once, and how many a second come back: a loop that logs on every frame fills the burst, not the terminal. */
const BURST = 20;
const PER_SECOND = 5;
const DEPTH = 3;
const ENTRIES = 50;

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

function describe(value: unknown, depth: number, seen: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return depth === 0 ? value : JSON.stringify(value);
    case 'symbol':
      return value.toString();
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    case 'object':
      break;
    default:
      return String(value);
  }
  if (value === null) return 'null';
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (seen.has(value)) return '[Circular]';
  if (depth > DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, ENTRIES).map((item) => describe(item, depth + 1, seen));
      if (value.length > ENTRIES) items.push(`… ${value.length - ENTRIES} more`);
      return `[ ${items.join(', ')} ]`;
    }
    const keys = Object.keys(value);
    const items = keys.slice(0, ENTRIES).map((key) => `${key}: ${describe((value as Record<string, unknown>)[key], depth + 1, seen)}`);
    if (keys.length > ENTRIES) items.push(`… ${keys.length - ENTRIES} more`);
    return items.length === 0 ? '{}' : `{ ${items.join(', ')} }`;
  } finally {
    seen.delete(value);
  }
}

/** Console arguments as text: strings as they are, other values to depth 3 (cycles as `[Circular]`), cut at the server's limit. */
export function formatArguments(args: readonly unknown[]): string {
  try {
    return cut(args.map((arg) => describe(arg, 0, new Set())).join(' '), MESSAGE_MAX);
  } catch {
    return '[unprintable]';
  }
}

const stackOf = (value: unknown): string | undefined => {
  try {
    const stack = value instanceof Error ? value.stack : undefined;
    return typeof stack === 'string' && stack ? cut(stack, STACK_MAX) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reports the page's errors through `send`, and returns the function that takes the hook away. The original `console.error` and
 * `console.warn` run first, with the arguments they got. A report that fails to build or send is dropped, and nothing that
 * happens inside the hook (a `console.error` of the send path, say) reports itself. Without a `send` — a page the dev server
 * does not serve — nothing is installed.
 */
export function installBrowserLog(
  target: BrowserLogTarget,
  send: ((report: BrowserReport) => void) | undefined,
  context: { readonly requestId?: string | undefined; readonly page: () => string },
  now: () => number = () => performance.now(),
): () => void {
  if (!send) return () => {};

  let busy = false;
  let tokens = BURST;
  let last: number | undefined;
  const take = (): boolean => {
    const at = now();
    if (last !== undefined) tokens = Math.min(BURST, tokens + (Math.max(0, at - last) / 1000) * PER_SECOND);
    last = at;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const report = (build: () => Omit<BrowserReport, 'page' | 'requestId'>): void => {
    if (busy) return;
    busy = true;
    try {
      if (!take()) return;
      const requestId = context.requestId;
      send({ ...build(), page: cut(context.page(), URL_MAX), ...(requestId ? { requestId } : {}) });
    } catch {
      // The report is lost; the page's own error handling is not ours to disturb.
    } finally {
      busy = false;
    }
  };

  const originals = { error: target.console.error, warn: target.console.warn };
  for (const level of ['error', 'warn'] as const) {
    const original = originals[level];
    target.console[level] = function (this: unknown, ...args: unknown[]) {
      try {
        return original.apply(this, args);
      } finally {
        report(() => {
          const stack = args.map(stackOf).find((candidate) => candidate !== undefined);
          return { kind: 'console', level, message: formatArguments(args), ...(stack ? { stack } : {}) };
        });
      }
    };
  }
  const wrapped = { error: target.console.error, warn: target.console.warn };

  const onError = (event: { message?: unknown; filename?: unknown; lineno?: unknown; colno?: unknown; error?: unknown }) =>
    report(() => {
      const stack = stackOf(event.error);
      const url = typeof event.filename === 'string' ? event.filename : '';
      const line = event.lineno;
      const column = event.colno;
      const located = url && typeof line === 'number' && typeof column === 'number' && Number.isSafeInteger(line) && Number.isSafeInteger(column) && line >= 0 && column >= 0;
      return {
        kind: 'error',
        level: 'error',
        message: cut(typeof event.message === 'string' && event.message ? event.message : formatArguments([event.error]), MESSAGE_MAX),
        ...(stack ? { stack } : {}),
        ...(located ? { source: { url: cut(url, URL_MAX), line: line as number, column: column as number } } : {}),
      };
    });
  const onRejection = (event: { reason?: unknown }) =>
    report(() => {
      const { reason } = event;
      const stack = stackOf(reason);
      return { kind: 'rejection', level: 'error', message: reason instanceof Error ? cut(`${reason.name}: ${reason.message}`, MESSAGE_MAX) : formatArguments([reason]), ...(stack ? { stack } : {}) };
    });
  target.addEventListener('error', onError as (event: ErrorEvent) => void);
  target.addEventListener('unhandledrejection', onRejection as (event: PromiseRejectionEvent) => void);

  return () => {
    // Another hook may have wrapped ours since: only take back what is still ours.
    if (target.console.error === wrapped.error) target.console.error = originals.error;
    if (target.console.warn === wrapped.warn) target.console.warn = originals.warn;
    target.removeEventListener('error', onError as (event: ErrorEvent) => void);
    target.removeEventListener('unhandledrejection', onRejection as (event: PromiseRejectionEvent) => void);
  };
}
