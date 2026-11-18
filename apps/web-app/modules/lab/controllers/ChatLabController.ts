import type { Authenticated } from '@marmeon/auth';
import { ChatNotifier } from '@marmeon/chat-notifications';
import { defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Notifications } from '@marmeon/notifications';
import { rules as r } from '@marmeon/validation';
import { LabConfig } from '../config.ts';
import { LAB_CHAT_DESTINATION, LabChatNotification } from '../notifications.ts';
import { LabGate } from './ValidationLabController.ts';
import { LabController } from './ShowLabPageController.ts';

export class ShowChatLabController extends LabController {
  readonly #chat: ChatNotifier;

  constructor(config: LabConfig, chat: ChatNotifier) {
    super(config);
    this.#chat = chat;
  }

  handle() {
    this.enabled();
    return this.view('lab/Chat', { unavailable: this.#chat.check(LAB_CHAT_DESTINATION) ?? null });
  }
}

/** Control and bidirectional characters come off first (the chat message drops them too): a message of nothing else is "required", and `max()` counts what is left. */
function withoutControls(text: string): string {
  return text.replace(/(?![\n\t])[\p{Cc}\p{Bidi_Control}]/gu, '');
}

export const ChatLabRequest = defineRequest({
  schema: r.object({ message: r.string().normalize(withoutControls).trim().required().max(500) }),
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

/** Sends the signed-in user a notification whose only channel is `chat`: it posts to the `ops` destination, not to the user. */
export class SendChatLabController extends LabController {
  static request = ChatLabRequest;
  readonly #notifications: Notifications;
  readonly #chat: ChatNotifier;

  constructor(config: LabConfig, notifications: Notifications, chat: ChatNotifier) {
    super(config);
    this.#notifications = notifications;
    this.#chat = chat;
  }

  async handle(ctx: ContextOf<typeof ChatLabRequest> & Authenticated) {
    this.enabled();
    // Without an `ops` entry in CHAT_WEBHOOKS the delivery would fail after the toast: refuse here, where the editor can read why.
    const problem = this.#chat.check(LAB_CHAT_DESTINATION);
    if (problem !== undefined) throw new ValidationError({ message: [problem] }, ctx.body);
    await this.#notifications.send({ type: 'user', id: ctx.user.id }, LabChatNotification, { message: ctx.body.message });
    return this.redirect('/lab/chat').flash('toast', { kind: 'success', message: 'The message is queued for the ops channel.' });
  }
}
