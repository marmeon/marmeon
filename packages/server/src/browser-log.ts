import type { BrowserLogMessage, MessageBase } from '@marmeon/core/diagnostics';

/** What a page may report, checked: a {@link BrowserLogMessage} without the fields the server adds. */
export type BrowserReport = Omit<BrowserLogMessage, keyof MessageBase> & { readonly requestId?: string };

const KINDS: ReadonlySet<unknown> = new Set(['console', 'error', 'rejection']);
const LEVELS: ReadonlySet<unknown> = new Set(['error', 'warn']);
const REQUEST_ID = /^[\w.:-]{1,128}$/;

const MESSAGE_MAX = 4096;
const STACK_MAX = 16_384;
const URL_MAX = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// C0 and C1 controls except newline and tab, DEL, and the line and paragraph separators: a terminal that shows the report
// (a log, an agent's console) would run an escape sequence (a cleared screen, an OSC-8 link) the page put in the text.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

function cut(value: string, max: number): string {
  const text = value.replace(CONTROLS, '');
  return text.length > max ? text.slice(0, max) : text;
}

function position(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Checks what a page sent on the HMR channel — anything running on the app's origin can send there. Only the known fields are
 * copied, strings are cut to their limits, and anything of the wrong type refuses the whole report (`undefined`). A
 * `requestId` that is not a request id is dropped; `dropped` is the limiter's to say, never the page's.
 */
export function acceptBrowserLog(data: unknown): BrowserReport | undefined {
  if (!isRecord(data)) return undefined;
  const { kind, level, message, stack, source, page, requestId } = data;
  if (!KINDS.has(kind) || !LEVELS.has(level)) return undefined;
  if (typeof message !== 'string' || typeof page !== 'string') return undefined;
  if (stack !== undefined && typeof stack !== 'string') return undefined;

  let where: BrowserReport['source'];
  if (source !== undefined) {
    if (!isRecord(source) || typeof source.url !== 'string') return undefined;
    const line = position(source.line);
    const column = position(source.column);
    if (line === undefined || column === undefined) return undefined;
    where = { url: cut(source.url, URL_MAX), line, column };
  }

  return {
    kind: kind as BrowserReport['kind'],
    level: level as BrowserReport['level'],
    message: cut(message, MESSAGE_MAX),
    ...(stack !== undefined ? { stack: cut(stack, STACK_MAX) } : {}),
    ...(where ? { source: where } : {}),
    page: cut(page, URL_MAX),
    ...(typeof requestId === 'string' && REQUEST_ID.test(requestId) ? { requestId } : {}),
  };
}

/** Reports one page may send at once, and how many it gets back per second; the budget of all pages together is four times that and five times the refill. */
export const CLIENT_BUDGET = { burst: 50, perSecond: 10 };
export const SHARED_BUDGET = { burst: 200, perSecond: 50 };

/**
 * A token bucket: `burst` reports at once, refilled at `perSecond` a second (one per HMR client, and one around all of them).
 * What it holds back is counted, and the next report it lets through carries the count.
 */
export class BrowserLogLimiter {
  readonly #burst: number;
  readonly #perSecond: number;
  #tokens: number;
  constructor({ burst, perSecond }: { burst: number; perSecond: number } = CLIENT_BUDGET) {
    this.#burst = burst;
    this.#perSecond = perSecond;
    this.#tokens = burst;
  }

  #last: number | undefined;
  #held = 0;

  /** `undefined`: hold this report back. Otherwise let it through, with how many were held back before it (0: none). */
  take(now: number = performance.now()): { dropped: number } | undefined {
    if (this.#last !== undefined) this.#tokens = Math.min(this.#burst, this.#tokens + (Math.max(0, now - this.#last) / 1000) * this.#perSecond);
    this.#last = now;
    if (this.#tokens < 1) {
      this.#held++;
      return undefined;
    }
    this.#tokens -= 1;
    const dropped = this.#held;
    this.#held = 0;
    return { dropped };
  }

  /** Counts reports another limiter held back after this one let them through. */
  hold(count: number): void {
    this.#held += count;
  }
}
