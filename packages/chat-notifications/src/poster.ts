import type { Clock, Logger } from '@marmeon/core';
import { FetchError, type HttpClient } from '@marmeon/fetch';
import { checkWebhook, type WebhookHref } from './destination.ts';
import { ChatDeliveryError, type ChatDeliveryReason, ChatError } from './errors.ts';
import type { ChatContent, ChatDestination } from './message.ts';
import { addressProblem, renderFor, type ChatTargets, type Rendered, type Target } from './targets.ts';

const MAX_RETRY_AFTER = 3600;
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The seconds a `Retry-After` header asks for: delta seconds (decimals rounded up) or an HTTP date minus now, clamped to 1 to 3600;
 * `undefined` for a header that is absent or is neither.
 * @internal
 */
export function retryAfterSeconds(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  let seconds: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) seconds = Number(text);
  else if (HTTP_DATE.test(text)) seconds = (Date.parse(text) - now) / 1000;
  else return undefined;
  if (Number.isNaN(seconds)) return undefined;
  return Math.min(MAX_RETRY_AFTER, Math.max(1, Math.ceil(seconds)));
}

/** The error code a provider's answer names, in the short form of that provider and nothing else: the body is the provider's, not ours. */
function providerCode(driver: string, text: string): string | undefined {
  const body = text.trim();
  if (driver === 'slack') return /^[a-z_]{1,64}$/.test(body) ? body : undefined;
  if (driver !== 'discord' && driver !== 'teams') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  if (driver === 'discord') {
    const { code } = parsed as { code?: unknown };
    return typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 ? String(code) : undefined;
  }
  const { error } = parsed as { error?: unknown };
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(code) ? code : undefined;
}

export interface PosterOptions {
  readonly targets: ChatTargets;
  /** Resolved for every request, so a test's `HttpClientFake` is the one used. */
  readonly http: () => HttpClient;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Protected environment: the log sink writes no text. */
  readonly protected: boolean;
}

/**
 * Posts one chat message. The only caller of `HttpClient.fetch` in this package: it checks the address itself, every time, whoever
 * calls it (the notifier, or the worker with a payload read from the queue), and only the address the guard returned is requested.
 * @internal
 */
export class ChatPoster {
  readonly #options: PosterOptions;

  constructor(options: PosterOptions) {
    this.#options = options;
  }

  /**
   * Posts `content` to `to`, or under `CHAT_DRIVER=log` writes where it would go and sends nothing. Throws `ChatDeliveryError`
   * (`refused` before any request for an address the driver does not accept) or `ChatError` for a destination or a raw format that
   * does not hold. No message names a webhook address.
   */
  async deliver(to: ChatDestination, content: ChatContent, signal?: AbortSignal): Promise<void> {
    const target = this.#options.targets.resolve(to);
    if (target.sink) return this.#log(target, content);
    const { driver } = target;
    if (driver === undefined) throw this.#refused(target, 'it has no driver');
    const checked = checkWebhook(target.url, driver, target.driverName);
    if (!checked.ok) throw this.#refused(target, checked.problem);
    return this.#post(checked.href, renderFor(driver, target.driverName, content), target, signal);
  }

  /** The `log` sink: the address is checked (its driver's rule when it names one, the basic rule otherwise) and never requested. */
  #log(target: Target, content: ChatContent): void {
    const problem = addressProblem(target);
    if (problem !== undefined) throw this.#refused(target, problem);
    this.#options.logger.info(`Chat message to ${target.label} (CHAT_DRIVER=log: not sent)`, {
      destination: target.label,
      title: content.title,
      ...(this.#options.protected ? {} : { text: content.text, fields: content.fields }),
    });
  }

  #refused(target: Target, problem: string): ChatDeliveryError {
    return new ChatDeliveryError('refused', `The chat message to ${target.label} was refused: ${problem}`);
  }

  async #post(href: WebhookHref, request: Rendered, target: Target, signal: AbortSignal | undefined): Promise<void> {
    const url = new URL(href);
    // the query of the address is left as written unless the driver adds to it
    for (const [key, value] of request.search) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.#options.http().fetch(url, {
        method: 'POST',
        json: request.json,
        redirect: 'error',
        timeout: 10,
        maxResponseBytes: 16 * 1024,
        headers: { accept: 'application/json, text/plain' },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw this.#failed(target, error);
    }
    if (response.status >= 200 && response.status < 300) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    let text = '';
    try {
      text = await response.text();
    } catch {
      // an answer that cannot be read still has its status
    }
    throw this.#answered(target, response.status, providerCode(target.driverName, text), response.headers.get('retry-after'));
  }

  #answered(target: Target, status: number, code: string | undefined, retryAfter: string | null): ChatDeliveryError {
    let reason: ChatDeliveryReason;
    let seconds: number | undefined;
    if (status === 429) {
      reason = 'throttled';
      seconds = retryAfterSeconds(retryAfter, this.#options.clock.now());
    } else if (status === 404 || status === 410) {
      reason = 'gone';
    } else if (status === 408 || status === 425 || status >= 500) {
      reason = 'unavailable';
      if (status === 503) seconds = retryAfterSeconds(retryAfter, this.#options.clock.now());
    } else {
      reason = 'rejected';
    }
    const message =
      `The chat message to ${target.label} was not delivered: ${target.driverName} answered ${status}${code === undefined ? '' : ` (${code})`}.` +
      (reason === 'gone' ? ' The webhook was deleted or disabled; it is not tried again.' : '');
    return new ChatDeliveryError(reason, message, {
      status,
      ...(code === undefined ? {} : { providerCode: code }),
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
    });
  }

  /**
   * A request that did not complete. No cause is kept: a transport error can hold the address (the client wraps whatever a
   * transport throws), so only the reason of the `FetchError` goes into the message.
   */
  #failed(target: Target, error: unknown): ChatError {
    const base = `The chat message to ${target.label} was not delivered:`;
    if (!(error instanceof FetchError)) return new ChatDeliveryError('unavailable', `${base} the request failed.`);
    if (error.reason === 'refused') return new ChatDeliveryError('refused', `${base} the HTTP client refused the request.`);
    if (error.reason === 'redirects') return new ChatDeliveryError('rejected', `${base} the webhook answered with a redirect, which is not followed.`);
    return new ChatDeliveryError('unavailable', `${base} the request ${error.reason === 'timeout' ? 'timed out' : error.reason === 'aborted' ? 'was aborted' : 'failed'}.`);
  }
}
