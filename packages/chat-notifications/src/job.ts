import type { Duration, StandardSchemaV1 } from '@marmeon/core';
import type { JobContext } from '@marmeon/queue';
import * as v from 'valibot';
import type { ChatJson } from './driver.ts';
import { ChatDeliveryError, ChatError } from './errors.ts';
import { normalizeMessage } from './message.ts';
import type { ChatPoster } from './poster.ts';
import type { ChatTargets } from './targets.ts';

/**
 * What a queued chat message carries: where it goes (a name from `CHAT_WEBHOOKS`, or the webhook address of a recipient with the
 * driver that formats for it) and the normalized neutral message, rendered by the worker's driver.
 */
export interface QueuedChatPayload {
  to: { name: string } | { url: string; driver?: string | undefined };
  content: {
    title?: string | undefined;
    text: string;
    fields: { label: string; value: string }[];
    links: { label: string; url: string }[];
    raw?: Record<string, ChatJson> | undefined;
  };
}

// `raw` is checked as a plain object only: a copy through a record schema would drop keys such as `constructor`, and `handle()`
// walks it with `normalizeMessage()` anyway.
const raw = v.custom<Record<string, ChatJson>>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), 'must be an object');


/** @internal The validation behind `SendQueuedChatMessage.schema`; the type tests compare its output with `QueuedChatPayload`. */
export const queuedChatSchema = v.object({
  to: v.union([v.strictObject({ name: v.string() }), v.strictObject({ url: v.string(), driver: v.optional(v.string()) })]),
  content: v.object({
    title: v.optional(v.string()),
    text: v.string(),
    fields: v.array(v.object({ label: v.string(), value: v.string() })),
    links: v.array(v.object({ label: v.string(), url: v.string() })),
    raw: v.optional(raw),
  }),
});

/**
 * The framework job behind `chat.queue()`: posts one message. **Encrypted** (APP_KEY): a recipient's webhook address is a secret and
 * travels inside the payload, so `jobs` and `failed_jobs` keep only ciphertext, bound to the job name. The worker checks the message and
 * the address again before it posts: a payload is data, not a promise. A webhook that answers `throttled` or `unavailable` is tried
 * again (waiting what it asks), one that is gone or refuses the message fails the job at once. Delivery is at-least-once.
 */
export class SendQueuedChatMessage {
  static readonly job = 'marmeon.chat';
  static readonly schema: StandardSchemaV1<QueuedChatPayload> = queuedChatSchema;
  static readonly encrypted = true;
  static readonly tries = 5;
  static readonly backoff: readonly Duration[] = [10, 60, 300];
  static readonly timeout = 30;

  readonly #poster: ChatPoster;
  readonly #targets: ChatTargets;

  /** @internal The container builds the job with the poster, never with the notifier: a test's fake notifier must not swallow it. */
  constructor(poster: ChatPoster, targets: ChatTargets) {
    this.#poster = poster;
    this.#targets = targets;
  }

  async handle(payload: QueuedChatPayload, job: JobContext): Promise<void> {
    try {
      const to = 'name' in payload.to ? payload.to.name : { url: payload.to.url, ...(payload.to.driver === undefined ? {} : { driver: payload.to.driver }) };
      const message = normalizeMessage({ ...payload.content, to });
      this.#targets.validate(message.to, message.content);
      await this.#poster.deliver(message.to, message.content, job.signal);
    } catch (error) {
      if (error instanceof ChatDeliveryError) {
        if ((error.reason === 'throttled' || error.reason === 'unavailable') && error.retryAfterSeconds !== undefined) return job.release(error.retryAfterSeconds);
        if (error.permanent) return job.fail(error);
        throw error;
      }
      // a destination or a driver this worker lacks, or content that does not hold: trying again will not change it
      if (error instanceof ChatError) return job.fail(error);
      throw error;
    }
  }
}
