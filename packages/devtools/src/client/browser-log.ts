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
/** How long after a send a `[vite]` error is taken for that send's own failure. */
const VITE_ECHO_MS = 5000;
const ENTRIES = 50;

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** What is left to write: one character budget and one node count for a whole message, so a wide, shared structure costs about the limit. */
interface Budget {
  left: number;
  nodes: number;
}
/** Values visited per message; with the character budget it bounds the work whatever the structure looks like. */
const NODES = 1000;
const UNPRINTABLE = '[unprintable]';

function describe(value: unknown, depth: number, seen: Set<object>, budget: Budget): string {
  if (budget.left <= 0 || ++budget.nodes > NODES) return '…';
  try {
    const text = write(value, depth, seen, budget);
    budget.left -= text.length;
    return text;
  } catch {
    // One hostile value (a throwing getter, a proxy trap) is its own text, not the others'.
    return UNPRINTABLE;
  }
}

function write(value: unknown, depth: number, seen: Set<object>, budget: Budget): string {
  switch (typeof value) {
    case 'string':
      return cut(depth === 0 ? value : JSON.stringify(cut(value, budget.left)), Math.max(budget.left, 1));
    case 'symbol':
      return value.toString();
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    case 'object':
      break;
    case 'bigint':
      return `${value}n`;
    default:
      return String(value);
  }
  if (value === null) return 'null';
  if (value instanceof Error) return cut(value.stack || `${value.name}: ${value.message}`, Math.max(budget.left, 1));
  if (seen.has(value)) return '[Circular]';
  if (depth > DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(value);
  try {
    // Children charge the budget themselves; this only stops when it is gone.
    const items: string[] = [];
    const many = (total: number, at: (index: number) => string) => {
      for (let index = 0; index < Math.min(total, ENTRIES); index++) {
        if (budget.left <= 0 || budget.nodes > NODES) {
          items.push('…');
          return;
        }
        const item = at(index);
        budget.left -= 2;
        items.push(item);
      }
      if (total > ENTRIES) items.push(`… ${total - ENTRIES} more`);
    };
    // A typed array is read by index like an array: `Object.keys` would make a string per element before anything is capped.
    if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
      const list = value as ArrayLike<unknown>;
      many(list.length, (index) => describe(list[index], depth + 1, seen, budget));
      return `[ ${items.join(', ')} ]`;
    }
    const keys = Object.keys(value);
    many(keys.length, (index) => {
      const key = cut(keys[index]!, Math.max(budget.left, 1));
      budget.left -= key.length;
      return `${key}: ${describe((value as Record<string, unknown>)[keys[index]!], depth + 1, seen, budget)}`;
    });
    return items.length === 0 ? '{}' : `{ ${items.join(', ')} }`;
  } finally {
    seen.delete(value);
  }
}

/** The `%` specifiers of the first argument (`%s %d %i %f %o %O`; `%c` and its argument go, `%%` is one `%`), as a console prints them. */
function substitute(template: string, rest: readonly unknown[], budget: Budget): { text: string; used: number } {
  let used = 0;
  const text = template.replace(/%([sdifoOc%])/g, (whole, specifier: string) => {
    if (specifier === '%') return '%';
    if (used >= rest.length) return whole;
    const arg = rest[used++];
    if (specifier === 'c') return '';
    try {
      switch (specifier) {
        case 'd':
          return typeof arg === 'bigint' ? `${arg}n` : typeof arg === 'symbol' ? 'NaN' : String(Number(arg));
        case 'i':
          return typeof arg === 'bigint' ? `${arg}n` : typeof arg === 'symbol' ? 'NaN' : String(Number.parseInt(String(arg), 10));
        case 'f':
          return typeof arg === 'symbol' ? 'NaN' : String(Number.parseFloat(String(arg)));
        default:
          return describe(arg, 0, new Set(), budget);
      }
    } catch {
      return UNPRINTABLE;
    }
  });
  return { text, used };
}

/** Console arguments as text: `%` specifiers filled, strings as they are, other values to depth 3 (cycles as `[Circular]`), cut at the server's limit. */
export function formatArguments(args: readonly unknown[]): string {
  const budget: Budget = { left: MESSAGE_MAX, nodes: 0 };
  try {
    const parts: string[] = [];
    let from = 0;
    const [first] = args;
    if (typeof first === 'string' && first.includes('%')) {
      const { text, used } = substitute(cut(first, MESSAGE_MAX), args.slice(1), budget);
      parts.push(text);
      from = 1 + used;
    }
    for (const arg of args.slice(from)) parts.push(describe(arg, 0, new Set(), budget));
    return cut(parts.join(' '), MESSAGE_MAX);
  } catch {
    return UNPRINTABLE;
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
  let stopped = false;
  let held = 0;
  let sentAt = -Infinity;
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
    if (stopped || busy) return;
    busy = true;
    try {
      if (!take()) {
        held++;
        return;
      }
      const requestId = context.requestId;
      const built = build();
      // The server refuses a count from the page: what this side held back goes into the next message's text.
      const note = held > 0 ? ` (${held} more held back on the page)` : '';
      const message = note ? cut(built.message, MESSAGE_MAX - note.length) + note : built.message;
      held = 0;
      sentAt = now();
      send({ ...built, message, page: cut(context.page(), URL_MAX), ...(requestId ? { requestId } : {}) });
    } catch {
      // The report is lost; the page's own error handling is not ours to disturb.
    } finally {
      busy = false;
    }
  };

  // Vite's HMR client logs `console.error('[vite]', error)` when its socket fails *after* `send` returned: that is this hook's
  // own send failing, shortly after it sent — reporting it would loop.
  const viteFailure = (args: readonly unknown[]): boolean => args[0] === '[vite]' && args.some((arg) => arg instanceof Error) && now() - sentAt < VITE_ECHO_MS;

  const originals = { error: target.console.error, warn: target.console.warn };
  for (const level of ['error', 'warn'] as const) {
    const original = originals[level];
    target.console[level] = function (this: unknown, ...args: unknown[]) {
      try {
        return original.apply(this, args);
      } finally {
        if (!viteFailure(args)) {
          report(() => {
            const stack = args.map(stackOf).find((candidate) => candidate !== undefined);
            return { kind: 'console', level, message: formatArguments(args), ...(stack ? { stack } : {}) };
          });
        }
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
    stopped = true;
    // Another hook may have wrapped ours since: only take back what is still ours.
    if (target.console.error === wrapped.error) target.console.error = originals.error;
    if (target.console.warn === wrapped.warn) target.console.warn = originals.warn;
    target.removeEventListener('error', onError as (event: ErrorEvent) => void);
    target.removeEventListener('unhandledrejection', onRejection as (event: PromiseRejectionEvent) => void);
  };
}
