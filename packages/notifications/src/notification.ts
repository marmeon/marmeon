import type { Duration, IsJson, StandardSchemaV1, Translator } from '@marmeon/core';

/**
 * Who notifications go to — kinds of recipients, by declaration merging: `interface NotificationRecipients { user: User }`.
 * A recipient travels as data (`{ type: 'user', id: 7 }`) and is found again where the notification is delivered, by its
 * module's resolver. See `docs/notifications.md#recipients`.
 */
export interface NotificationRecipients {}

/** The kinds of recipients the app declared (`interface NotificationRecipients`). */
export type RecipientType = keyof NotificationRecipients & string;

/** The id of a recipient of a kind: its record's `id`, else a string or a number. */
export type RecipientId<T extends RecipientType> = NotificationRecipients[T] extends { readonly id: infer I extends string | number } ? I : string | number;

/** A recipient as data: its kind and its id — `{ type: 'user', id: user.id }`. */
export type RecipientRef<T extends RecipientType = RecipientType> = { [K in T]: { readonly type: K; readonly id: RecipientId<K> } }[T];

/** A recipient as the framework handles it inside (the app's kinds are not known there). */
export interface AnyRecipient {
  readonly type: string;
  readonly id: string | number;
}

/**
 * A mail as the `mail` channel needs it — a `Mailable` of @marmeon/mail (its envelope says who gets it, its content
 * is composed in the recipient's language).
 */
export interface NotificationMail {
  envelope(): unknown;
  content(): unknown;
}

/**
 * The channels a notification can go through, and what a notification needs for each — open to other packages by
 * declaration merging (`live` comes with @marmeon/live). See `docs/notifications.md#a-channel-of-your-own`.
 */
export interface NotificationChannelMap {
  /** A mail, composed by `toMail(recipient, data, t)` in the recipient's language and queued (`mailer.queue`). */
  mail: { toMail(recipient: any, data: any, t: Translator): NotificationMail | Promise<NotificationMail> };
  /** A row in the `notifications` table — what `toDatabase(data, recipient)` returns, checked by `static database`. */
  database: { toDatabase(data: any, recipient: any): unknown };
}

/** The name of a channel: `'mail'`, `'database'` — and whatever packages add. */
export type NotificationChannelName = keyof NotificationChannelMap & string;

/** Where and how a notification's job runs (`static queue`) — its mail goes to the same queue. */
export interface NotificationQueueOptions {
  /** The queue of the notification's job and of its mail (default: the connection's default queue). */
  readonly queue?: string;
  /** The queue connection (default: `QUEUE_DRIVER`). */
  readonly connection?: string;
  /** Deliver no earlier than this — seconds, or a duration. */
  readonly delay?: Duration;
  /** Attempts of the job in all (default 3). */
  readonly tries?: number;
  /** The wait before the next attempt — one value, or one per retry (the last repeats); seconds or a duration. Default [10, 60, 300]. */
  readonly backoff?: Duration | readonly Duration[];
}

/** The static side of a notification class: a stable name and the schema of its data — like a job's. */
export interface NotificationStatics {
  /** The notification's stable name — what the queue and the `notifications` table store, never the class name: `'auth.new-sign-in'`. */
  readonly notification: string;
  /** The schema of its data (Standard Schema) — checked when it is sent and again before it is delivered. */
  readonly schema: StandardSchemaV1;
  /** The schema of what `toDatabase()` returns — what the `notifications` table keeps and the inbox reads back. */
  readonly database?: StandardSchemaV1;
  /** Where its job runs (and its mail is queued). */
  readonly queue?: NotificationQueueOptions;
}

/** An instance of a notification: built per delivery through the container (constructor injection). */
export interface NotificationInstance {
  via(recipient: any, data: any): readonly string[] | Promise<readonly string[]>;
}

/** A notification class — `static notification`, `static schema`, `via()` and a `to…()` per channel. */
export type NotificationClass = NotificationStatics & (new (...args: any[]) => NotificationInstance);

/**
 * What a notification class implements (optional, for checks where it is written): `via()` gets the recipient's record
 * of kind `T` and returns channels this app has. See `docs/notifications.md#defining-notifications`.
 */
export interface Notification<T extends RecipientType = RecipientType> {
  via(recipient: NotificationRecipients[T], data: any): readonly NotificationChannelName[] | Promise<readonly NotificationChannelName[]>;
}

/**
 * Finds the recipients of one kind again where a notification is delivered (a worker) — and says what the channels need
 * to know of them. Listed in a module: `defineModule({ recipients: { user: UserRecipients } })`; built through the
 * container (constructor injection).
 */
export interface RecipientResolver<T extends RecipientType = RecipientType> {
  /** The recipient's record — undefined when it is gone (the notification is then dropped). */
  find(id: RecipientId<T>): Promise<NotificationRecipients[T] | undefined>;
  /** The recipient's language — its mails are composed in it (`Translators.for`); default: `APP_LOCALE`. */
  locale?(recipient: NotificationRecipients[T]): string | null | undefined;
}

export type RecipientResolverClass<T extends RecipientType = RecipientType> = new (...args: any[]) => RecipientResolver<T>;

/** A resolver as the framework handles it inside (the app's kinds are not known there). */
export type AnyRecipientResolverClass = new (...args: any[]) => { find(id: any): Promise<unknown>; locale?(recipient: any): string | null | undefined };

/** A module's resolvers, by kind of recipient: `{ user: UserRecipients }`. */
export type RecipientResolvers = { readonly [T in RecipientType]?: RecipientResolverClass<T> };

type SchemaInput<S> = S extends StandardSchemaV1 ? NonNullable<S['~standard']['types']>['input'] : never;
type SchemaOutput<S> = S extends StandardSchemaV1 ? NonNullable<S['~standard']['types']>['output'] : never;

/** What the `to…()` methods and `via()` get: the output of the notification's `static schema`. */
export type NotificationData<N extends { readonly schema: StandardSchemaV1 }> = SchemaOutput<N['schema']>;

/** What a notification is sent with: the input of its `static schema`. */
export type NotificationInput<N extends { readonly schema: StandardSchemaV1 }> = SchemaInput<N['schema']>;

/** What `toDatabase()` returns: the input of `static database` — `toDatabase(data): DatabaseInput<typeof MyNotification>`. */
export type DatabaseInput<N extends { readonly database?: StandardSchemaV1 }> = SchemaInput<N['database']>;

/** What the inbox reads back of a notification of this class: the output of `static database`. */
export type DatabaseData<N extends { readonly database?: StandardSchemaV1 }> = SchemaOutput<N['database']>;

// --- Checks where a notification is sent (message-as-type) ---------------------------------------------------------

type InstanceOf<N> = N extends new (...args: any[]) => infer I ? I : never;
/** `via()`'s recipient (anything, when it takes none) and the channels it returns. */
type ViaOf<N> = InstanceOf<N> extends { via(...args: infer A): infer R } ? { readonly recipient: A extends readonly [] ? unknown : A[0]; readonly channels: Awaited<R> } : never;
/** The channels `via()` can return. */
export type ChannelsOf<N> = ViaOf<N>['channels'] extends readonly (infer C)[] ? C : never;

type MissingChannelMethods<N> = {
  [C in ChannelsOf<N> & NotificationChannelName]: InstanceOf<N> extends NotificationChannelMap[C] ? never : C;
}[ChannelsOf<N> & NotificationChannelName];

type DatabaseReturn<N> = InstanceOf<N> extends { toDatabase(...args: any[]): infer R } ? Awaited<R> : never;

type CheckDatabase<N> = 'database' extends ChannelsOf<N>
  ? N extends { readonly database: StandardSchemaV1 }
    ? [Exclude<keyof DatabaseReturn<N>, keyof DatabaseInput<N>>] extends [never]
      ? DatabaseReturn<N> extends DatabaseInput<N>
        ? unknown
        : { readonly 'toDatabase() returns other values than static database describes': { readonly returns: DatabaseReturn<N>; readonly database: DatabaseInput<N> } }
      : { readonly 'toDatabase() returns fields that static database does not have — they would not be stored': Exclude<keyof DatabaseReturn<N>, keyof DatabaseInput<N>> }
    : { readonly database: 'A notification through the database channel needs static database — the schema of what toDatabase() returns (the inbox reads it back)' }
  : unknown;

type CheckChannels<N> = string extends ChannelsOf<N>
  ? { readonly "via() must say which channels — return them as const: return ['database', 'mail'] as const": ChannelsOf<N> }
  : [Exclude<ChannelsOf<N>, NotificationChannelName>] extends [never]
    ? [MissingChannelMethods<N>] extends [never]
      ? CheckDatabase<N>
      : { readonly 'via() returns a channel whose method the notification lacks — mail needs toMail(recipient, data, t), database needs toDatabase(data)': MissingChannelMethods<N> }
    : { readonly 'via() returns a channel this app does not have': { readonly unknown: Exclude<ChannelsOf<N>, NotificationChannelName>; readonly known: NotificationChannelName } };

type CheckClass<N, T extends RecipientType> =
  IsJson<NotificationInput<N & { schema: StandardSchemaV1 }>> extends false
    ? {
        readonly 'The static schema of a notification describes JSON (strings, numbers, booleans, null, arrays, plain objects) — its data is queued: pass IDs, not records, Dates or Maps': NotificationInput<
          N & { schema: StandardSchemaV1 }
        >;
      }
    : [NotificationRecipients[T]] extends [ViaOf<N>['recipient']]
      ? CheckChannels<N>
      : { readonly 'via() of this notification takes another kind of recipient than it is sent to': { readonly sentTo: T; readonly via: ViaOf<N>['recipient'] } };

/**
 * Checks a notification class where it is sent to a recipient of kind `T`: its name and schema, JSON data, `via()` for
 * that kind, channels the app has, a `to…()` method per channel, `toDatabase()` against `static database`. A failed
 * check is a type whose name says what is wrong.
 */
export type CheckNotification<N, T extends RecipientType> = N extends { readonly notification: string; readonly schema: StandardSchemaV1 } & (new (...args: any[]) => { via(...args: any[]): unknown })
  ? CheckClass<N, T>
  : { readonly notification: 'A notification class needs static notification = "module.what-happened" (a stable name, never the class name), static schema and via(recipient)' };

/** One recipient or several. */
export type Recipients = RecipientRef | readonly RecipientRef[];
/** The kind(s) of recipients of a `send()`. */
export type RecipientTypeOf<R> = R extends readonly (infer E)[] ? (E extends { readonly type: infer T extends RecipientType } ? T : never) : R extends { readonly type: infer T extends RecipientType } ? T : never;
/** What `send()` resolves with: the notification's id — one per recipient for a list. */
export type SendResult<R> = R extends readonly unknown[] ? string[] : string;
