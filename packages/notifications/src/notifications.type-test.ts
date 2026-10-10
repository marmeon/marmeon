// Type guarantees of notifications — checked by `tsc` (pnpm build / typecheck), never run.
import * as v from 'valibot';
import type { Member } from './__fixtures__/app.ts';
import { OrderShipped, Welcome } from './__fixtures__/app.ts';
import type { Inbox } from './inbox.ts';
import type { DatabaseInput, Notification, NotificationData } from './notification.ts';
import type { Notifications } from './notifications.ts';

declare const notifications: Notifications;
declare const inbox: Inbox;
const ada = { type: 'member', id: 1 } as const;

/** Through the database and an SMS gateway nobody has. */
class Texted {
  static readonly notification = 'shop.texted';
  static readonly schema = v.object({ code: v.string() });
  static readonly database = v.object({ code: v.string() });
  via() {
    return ['database', 'sms'] as const;
  }
  toDatabase(data: NotificationData<typeof Texted>) {
    return { code: data.code };
  }
}

/** Stores a field its static database does not have. */
class Leaky {
  static readonly notification = 'shop.leaky';
  static readonly schema = v.object({ code: v.string(), secret: v.string() });
  static readonly database = v.object({ code: v.string() });
  via() {
    return ['database'] as const;
  }
  toDatabase(data: NotificationData<typeof Leaky>) {
    return { code: data.code, secret: data.secret };
  }
}

/** No static notification. */
class Nameless {
  static readonly schema = v.object({});
  via() {
    return ['database'] as const;
  }
}

/** Mail in via(), but no toMail(). */
class Mute {
  static readonly notification = 'shop.mute';
  static readonly schema = v.object({});
  via() {
    return ['mail'] as const;
  }
}

/** via() without `as const`: string[]. */
class Vague {
  static readonly notification = 'shop.vague';
  static readonly schema = v.object({});
  via() {
    return ['database'];
  }
}

/** For teams. */
class TeamNews {
  static readonly notification = 'shop.team-news';
  static readonly schema = v.object({});
  static readonly database = v.object({});
  via(_team: { readonly id: string; readonly name: string }) {
    return ['database'] as const;
  }
  toDatabase() {
    return {};
  }
}

/** A Date in its data. */
class Dated {
  static readonly notification = 'shop.dated';
  static readonly schema = v.object({ at: v.date() });
  via() {
    return [] as const;
  }
}

export async function sends(): Promise<void> {
  // Fine: a member, a registered shape, the data its schema takes.
  const id: string = await notifications.send(ada, OrderShipped, { orderId: 'o-1' });
  const ids: string[] = await notifications.send([ada, { type: 'member', id: 2 }], Welcome, { code: 'x' });
  await notifications.sendNow(ada, Welcome, { code: 'x' });
  await notifications.send({ type: 'team', id: 'core' }, TeamNews, {});
  void id;
  void ids;

  // @ts-expect-error — an unknown kind of recipient
  await notifications.send({ type: 'robot', id: 1 }, Welcome, { code: 'x' });
  // @ts-expect-error — a member's id is a number
  await notifications.send({ type: 'member', id: '1' }, Welcome, { code: 'x' });
  // @ts-expect-error — the wrong data
  await notifications.send(ada, Welcome, { code: 7 });
  // @ts-expect-error — data the schema does not know
  await notifications.send(ada, Welcome, { code: 'x', extra: 1 });
  // @ts-expect-error — via() returns a channel the app does not have
  await notifications.send(ada, Texted, { code: 'x' });
  // @ts-expect-error — toDatabase() returns a field static database does not have
  await notifications.send(ada, Leaky, { code: 'x', secret: 's' });
  // @ts-expect-error — no static notification
  await notifications.send(ada, Nameless, {});
  // @ts-expect-error — mail in via(), no toMail()
  await notifications.send(ada, Mute, {});
  // @ts-expect-error — via() must name its channels (as const)
  await notifications.send(ada, Vague, {});
  // @ts-expect-error — a team's notification sent to a member
  await notifications.send(ada, TeamNews, {});
  // @ts-expect-error — a Date in the data (it is queued as JSON)
  await notifications.sendNow(ada, Dated, { at: new Date() });
}

export async function reads(): Promise<void> {
  await inbox.count(ada);
  await inbox.markRead(ada, 'id');
  // @ts-expect-error — the inbox is always bound to a recipient
  await inbox.markRead('id');
  // @ts-expect-error — an unknown kind of recipient
  await inbox.count({ type: 'robot', id: 1 });
}

// Where the class is written: `implements Notification<'member'>` checks via() against the kinds and the channels.
export class Checked implements Notification<'member'> {
  static readonly notification = 'shop.checked';
  static readonly schema = v.object({ code: v.string() });
  static readonly database = v.object({ code: v.string() });
  via(member: Member) {
    return member.verified ? (['database', 'mail'] as const) : (['database'] as const);
  }
  // An annotated return checks the fields where they are written.
  toDatabase(data: NotificationData<typeof Checked>): DatabaseInput<typeof Checked> {
    // @ts-expect-error — not in static database
    return { code: data.code, extra: true };
  }
}

// @ts-expect-error — an unknown kind of recipient
export class ForRobots implements Notification<'robot'> {
  via() {
    return ['database'] as const;
  }
}

export class Faxing implements Notification<'member'> {
  // @ts-expect-error — via() returns a channel the app does not have
  via() {
    return ['fax'] as const;
  }
}
