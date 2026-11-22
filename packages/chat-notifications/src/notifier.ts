import { token, type Duration } from '@marmeon/core';
import { describeDestination } from './destination.ts';
import { ChatAddressError, ChatDriverError, ChatError } from './errors.ts';
import type { QueuedChatPayload } from './job.ts';
import { normalizeDeferred, normalizeMessage, type ChatContent, type ChatDestination, type ChatMessage } from './message.ts';
import type { ChatPoster } from './poster.ts';
import { addressProblem, type ChatTargets, type Target } from './targets.ts';

/** Where and when a queued chat message goes (`chat.queue(message, options)`). */
export interface QueueChatOptions {
  /** The queue (default: the connection's default queue). A worker without `--queue` takes it; one with `--queue` must name it. */
  readonly queue?: string;
  /** The queue connection (default: `QUEUE_DRIVER`). */
  readonly connection?: string;
  /** Send no earlier than this — seconds, or a duration (`{ minutes: 5 }`). The `sync` queue connection posts without the delay and logs a warning, one for all queued chat messages. */
  readonly delay?: Duration;
}

/**
 * Posts chat messages to Slack, Discord or Microsoft Teams through incoming webhooks. See `docs/chat-notifications.md#sending-without-notifications`.
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
  /** Why `to` is refused, or `undefined` when messages can go there: use it where a user enters a webhook address (`docs/chat-notifications.md#destinations`). */
  check(to: ChatDestination): string | undefined;
}
export const ChatNotifier = token<ChatNotifier>('ChatNotifier');

/** Puts a payload on the queue — the `marmeon.chat` job (`ChatServiceProvider` wires it to @marmeon/queue, and throws `ChatError` when the app has none). */
export type ChatQueue = ((payload: QueuedChatPayload, options: QueueChatOptions) => Promise<unknown>) & {
  /** Throws `ChatError` when the app has no queue to put a message on, without dispatching anything. */
  ready(): Promise<void>;
};

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

/**
 * Every check `queue()` makes before anything is queued, in their order: the message, the destination and driver, the message
 * against the driver, that there is a queue (`ready`), then the address. The fake notifier runs the same function with its own `ready`.
 * @internal
 */
export async function checkQueued(targets: ChatTargets, message: ChatMessage, ready: () => Promise<void>): Promise<{ readonly to: ChatDestination; readonly content: ChatContent }> {
  const { to, content, addressError } = normalizeDeferred(message);
  // Every check of the code comes first; only then is an address refused, which is data (`ChatAddressError`): an unknown
  // destination or driver, a raw format the driver refuses or a driver that threw all win over a refused address.
  const refused = (problem: string) => `The chat message to ${describeDestination(to)} is refused: ${problem}`;
  let target: Target;
  try {
    target = targets.resolve(to);
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    // a driver that threw stays one (its class tells it from a mistake), with what it threw as the cause
    if (error instanceof ChatDriverError) throw new ChatDriverError(refused(error.message), { cause: error.cause });
    throw new ChatError(refused(error.message), error.cause === undefined ? undefined : { cause: error.cause });
  }
  targets.validate(to, content);
  // a missing queue is a mistake of the setup: it is told before an address is refused, which a notification skips and so would hide it
  await ready();
  if (addressError !== undefined) throw addressError;
  const problem = addressProblem(target);
  if (problem !== undefined) throw new ChatAddressError(refused(problem));
  return { to, content };
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
    const { to, content } = await checkQueued(this.#targets, message, () => this.#queue.ready());
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
