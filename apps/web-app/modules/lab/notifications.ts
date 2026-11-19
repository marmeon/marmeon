import type { ChatMessage } from '@marmeon/chat-notifications';
import type { Notification, NotificationData } from '@marmeon/notifications';
import { rules as r } from '@marmeon/validation';

/** The destination of `CHAT_WEBHOOKS` the lab posts to. */
export const LAB_CHAT_DESTINATION = 'ops';

/** A message an editor typed in the lab, posted to the `ops` destination of `CHAT_WEBHOOKS` (the app needs an `ops` entry): its only channel is `chat`. */
export class LabChatNotification implements Notification<'user'> {
  static readonly notification = 'lab.chat';
  static readonly schema = r.object({ message: r.string() });

  via() {
    return ['chat'] as const;
  }

  /** The text stays as typed: what a provider would read as a mention or a link is the driver's to neutralise. */
  toChat(_user: unknown, data: NotificationData<typeof LabChatNotification>): ChatMessage {
    return { to: LAB_CHAT_DESTINATION, title: 'A message from the lab', text: data.message, links: [{ label: 'Marmeon', url: 'https://marmeon.com' }] };
  }
}
