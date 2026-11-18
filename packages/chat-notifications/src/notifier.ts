import { token, type Duration } from '@marmeon/core';
import { describeDestination } from './destination.ts';
import { ChatError } from './errors.ts';
import type { QueuedChatPayload } from './job.ts';
import { normalizeMessage, type ChatContent, type ChatDestination, type ChatMessage } from './message.ts';
import type { ChatPoster } from './poster.ts';
import type { ChatTargets } from './targets.ts';

/** Where and when a queued chat message goes (`chat.queue(message, options)`). */
export interface QueueChatOptions {
  /** The queue (default: the connection's default queue). A worker without `--queue` takes it; one with `--queue` must name it. */
  readonly queue?: string;
  /** The queue connection (default: `QUEUE_DRIVER`). */
  readonly connection?: string;
  /** Send no earlier than this — seconds, or a duration (`{ minutes: 5 }`). */
  readonly delay?: Duration;
}

/**
 * Posts chat messages to Slack, Discord or Microsoft Teams through incoming webhooks. See `docs/drivers.md#chat-drivers`.
 */
export interface ChatNotifier {
  /**
   * Posts the message now and resolves when the webhook took it. A message to an address its driver does not accept throws a
   * `ChatDeliveryError` (`refused`) before any request; one the provider does not take throws one with the reason. A mistake in the
   * message, a destination `CHAT_WEBHOOKS` does not list, a driver nobody brought or a raw format the driver refuses throws
   * `ChatError`, also before any request. Inside a
   * transaction the message goes out before the commit and a rollback does not take it back: use `queue()` there.
   */
  send(message: ChatMessage): Promise<void>;
  /**
   * Checks the message and the destination at once, then queues it as the encrypted job `marmeon.chat`, which posts it with
   * retries of its own. A mistake in the message, a destination `CHAT_WEBHOOKS` does not list, or an address its driver does not
   * accept throws `ChatError` here. Needs @marmeon/queue and APP_KEY.
   */
  queue(message: ChatMessage, options?: QueueChatOptions): Promise<void>;
  /** Why `to` is refused, or `undefined` when messages can go there: use it where a user enters a webhook address. */
  check(to: ChatDestination): string | undefined;
}
export const ChatNotifier = token<ChatNotifier>('ChatNotifier');

/** Puts a payload on the queue — the `marmeon.chat` job (`ChatServiceProvider` wires it to @marmeon/queue, and throws `ChatError` when the app has none). */
export type ChatQueue = (payload: QueuedChatPayload, options: QueueChatOptions) => Promise<unknown>;

function payloadOf(to: ChatDestination, content: ChatContent): QueuedChatPayload {
  return {
    to: typeof to === 'string' ? { name: to } : { url: to.url, ...(to.driver === undefined ? {} : { driver: to.driver }) },
    content: {
      ...(content.title === undefined ? {} : { title: content.title }),
      text: content.text,
      fields: content.fields.map((field) => ({ ...field })),
      links: content.links.map((link) => ({ ...link })),
      ...(content.raw === undefined ? {} : { raw: { ...content.raw } }),
    },
  };
}

/** @internal */
export class WebhookChatNotifier implements ChatNotifier {
  readonly #targets: ChatTargets;
  readonly #poster: ChatPoster;
  readonly #queue: ChatQueue;

  constructor(targets: ChatTargets, poster: ChatPoster, queue: ChatQueue) {
    this.#targets = targets;
    this.#poster = poster;
    this.#queue = queue;
  }

  async send(message: ChatMessage): Promise<void> {
    const { to, content } = normalizeMessage(message);
    this.#targets.validate(to, content);
    await this.#poster.deliver(to, content);
  }

  async queue(message: ChatMessage, options: QueueChatOptions = {}): Promise<void> {
    const { to, content } = normalizeMessage(message);
    const problem = this.#targets.problem(to);
    if (problem !== undefined) throw new ChatError(`The chat message to ${describeDestination(to)} is refused: ${problem}`);
    this.#targets.validate(to, content);
    await this.#queue(payloadOf(to, content), {
      ...(options.queue === undefined ? {} : { queue: options.queue }),
      ...(options.connection === undefined ? {} : { connection: options.connection }),
      ...(options.delay === undefined ? {} : { delay: options.delay }),
    });
  }

  check(to: ChatDestination): string | undefined {
    let normalized: ChatDestination;
    try {
      normalized = normalizeMessage({ to, text: 'x' }).to;
    } catch (error) {
      if (error instanceof ChatError) return error.message;
      throw error;
    }
    return this.#targets.problem(normalized);
  }
}
