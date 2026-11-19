// Type guarantees of the `chat` channel — checked by `tsc` (typecheck), never run.
import type { NotificationChannelName, Notification, NotificationData, Notifications } from '@marmeon/notifications';
import * as v from 'valibot';
import type { ChatMessage } from './message.ts';
import './notifications.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare module '@marmeon/notifications' {
  interface NotificationRecipients {
    pinger: { readonly id: number; readonly name: string };
  }
}

declare const notifications: Notifications;
const ada = { type: 'pinger', id: 1 } as const;

// Once the package is imported, `via()` may name the channel.
export type HasChat = Expect<Equal<'chat' extends NotificationChannelName ? true : false, true>>;

/** Chat in via(), but no toChat(). */
class Mute {
  static readonly notification = 'shop.mute';
  static readonly schema = v.object({});
  via() {
    return ['chat'] as const;
  }
}

/** A message without its text. */
class Textless {
  static readonly notification = 'shop.textless';
  static readonly schema = v.object({});
  via() {
    return ['chat'] as const;
  }
  toChat() {
    return { to: 'ops' } as const;
  }
}

/** A message to nowhere in particular. */
class Aimless {
  static readonly notification = 'shop.aimless';
  static readonly schema = v.object({});
  via() {
    return ['chat'] as const;
  }
  toChat() {
    return { text: 'hello' } as const;
  }
}

/** Composed in the recipient's language, to the recipient's own address or to `ops`; `toChat` may be async. */
class Alerted {
  static readonly notification = 'shop.alerted';
  static readonly schema = v.object({ order: v.string() });
  via() {
    return ['chat'] as const;
  }
  async toChat(pinger: { readonly name: string }, data: NotificationData<typeof Alerted>, t: { readonly locale: string }) {
    return { to: 'ops', title: pinger.name, text: `${t.locale}: ${data.order}`, fields: [{ label: 'Order', value: data.order }] } satisfies ChatMessage;
  }
}

export async function sends(): Promise<void> {
  await notifications.send(ada, Alerted, { order: 'o-1' });
  await notifications.sendNow(ada, Alerted, { order: 'o-1' });

  // @ts-expect-error — chat in via(), no toChat()
  await notifications.send(ada, Mute, {});
  // @ts-expect-error — toChat() returns a message without its text
  await notifications.send(ada, Textless, {});
  // @ts-expect-error — toChat() returns a message without its destination
  await notifications.send(ada, Aimless, {});
}

// Where the class is written: `implements Notification<'pinger'>` checks `via()` only; an annotated return checks the message where it is written.
export class Checked implements Notification<'pinger'> {
  static readonly notification = 'shop.checked';
  static readonly schema = v.object({});
  via() {
    return ['chat'] as const;
  }
  toChat(pinger: { readonly name: string }): ChatMessage {
    return { to: 'ops', text: pinger.name };
  }
}

export class Annotated {
  toChat(): ChatMessage {
    // @ts-expect-error — the annotated message needs its text
    return { to: 'ops' };
  }
}
