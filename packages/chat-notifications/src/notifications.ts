import type { Logger, Translator } from '@marmeon/core';
import { NotificationChannelError, NotificationError, type Delivery, type NotificationChannel } from '@marmeon/notifications';
import { describeDestination } from './destination.ts';
import { ChatAddressError, ChatDriverError, ChatError } from './errors.ts';
import type { ChatMessage } from './message.ts';
import type { ChatNotifier } from './notifier.ts';

declare module '@marmeon/notifications' {
  interface NotificationChannelMap {
    /**
     * A chat message, composed by `toChat(recipient, data, t)` in the recipient's language and queued (`marmeon.chat`): part of the
     * delivery's transaction with a database queue on the same connection. A webhook address the recipient entered that its driver
     * does not accept (an empty or over-long one included) is skipped with a warning and the other channels are delivered; a mistake of the code or the configuration (a
     * destination `CHAT_WEBHOOKS` lacks, an unknown driver, whose name comes from code or a validated list and never from the recipient's input, a malformed message) fails the delivery at once; a driver that throws,
     * or a queue that is down, is retried with the notification job. See `docs/notifications.md#the-chat-channel`.
     */
    chat: { toChat(recipient: any, data: any, t: Translator): ChatMessage | Promise<ChatMessage> };
  }
}

/**
 * The notifications' `chat` channel: `toChat(recipient, data, t)` composes the message in the recipient's language and it is **queued**
 * (`chat.queue()`: encrypted, posted by a worker) on the notification's queue — with a database queue on the same connection it is part
 * of the delivery's transaction. A webhook that is down retries the message alone, never the notification's other channels, and no
 * request is made while the transaction is open. What happens to a message that cannot be queued:
 *
 * - an address of the recipient (`{ url }`) that its driver does not accept, or that is empty or too long, is **skipped with a warning**
 *   (the notification type and the host, never the path): the address is data the recipient entered, and it must not suppress the
 *   notification's other channels. Every check of the code comes first: a message that is also malformed fails as below;
 * - a mistake of the code or the configuration (a named destination `CHAT_WEBHOOKS` lacks, an unknown driver, a malformed message, a
 *   refused raw format, no queue) fails the delivery **at once** as a `NotificationChannelError`. A destination's `driver` therefore comes
 *   from code or a validated list, never from the recipient's raw input;
 * - a `ChatDriverError` (a driver that threw) and any other error (a queue that is down) are rethrown: the notification job's
 *   tries and backoff apply.
 *
 * Loaded only when the app has @marmeon/notifications (an optional peer): the provider imports this file then.
 * @internal
 */
export class ChatChannel implements NotificationChannel {
  readonly #notifier: ChatNotifier;
  readonly #logger: Logger;

  constructor(notifier: ChatNotifier, logger: Logger) {
    this.#notifier = notifier;
    this.#logger = logger;
  }

  async deliver(delivery: Delivery): Promise<void> {
    const { class: Class, notification } = delivery;
    const toChat = (notification as { toChat?: (recipient: unknown, data: unknown, t: Translator) => ChatMessage | Promise<ChatMessage> }).toChat;
    if (typeof toChat !== 'function') throw new NotificationError(`${Class.name} (${delivery.type}) goes through the chat channel, but has no toChat(recipient, data, t) method.`);
    const message = await toChat.call(notification, delivery.record, delivery.data, delivery.translator);
    try {
      await this.#notifier.queue(message, delivery.queue);
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      // a recipient's own address: skipped, the delivery's other channels go on
      if (error instanceof ChatAddressError && typeof message.to === 'object') {
        this.#logger.warn(`${Class.name} (${delivery.type}): the chat message was not queued, ${describeDestination(message.to)} is refused.`, { notification: delivery.type });
        return;
      }
      // a driver that threw: a retry may fix it
      if (error instanceof ChatDriverError) throw error;
      throw new NotificationChannelError(`${Class.name} (${delivery.type}): ${error.message}`, { cause: error });
    }
  }
}
