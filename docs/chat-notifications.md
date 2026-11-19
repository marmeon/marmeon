# Chat Notifications

## Introduction

A chat message tells your team that something happened: a large order, a failed payment, a deploy that finished. `@marmeon/chat-notifications`
posts it to Slack, Discord or Microsoft Teams through an incoming webhook. You write one neutral message, with a title, a text,
fields and links, and the driver you configured shapes it for its provider. The package posts through webhooks only. It is no bot
and reads nothing from your channels.

You use it as a channel of [notifications](notifications.md#the-chat-channel), or on its own through `ChatNotifier`. A notification
that goes to the app's list and to a channel of your team:

```ts title="modules/orders/notifications/LargeOrderNotification.ts"
import type { ChatMessage } from '@marmeon/chat-notifications';
import type { DatabaseInput, Notification, NotificationData } from '@marmeon/notifications';
import { rules as r } from '@marmeon/validation';

export class LargeOrderNotification implements Notification<'user'> {
  static readonly notification = 'orders.large';
  static readonly schema = r.object({ number: r.string(), total: r.string(), url: r.string() });
  static readonly database = r.object({ number: r.string() });

  via() {
    return ['database', 'chat'] as const;
  }

  toDatabase(data: NotificationData<typeof LargeOrderNotification>): DatabaseInput<typeof LargeOrderNotification> {
    return { number: data.number };
  }

  toChat(_user: unknown, data: NotificationData<typeof LargeOrderNotification>): ChatMessage {
    return {
      to: 'ops',
      title: 'Large order',
      text: `Order ${data.number} is over the limit.`,
      fields: [{ label: 'Total', value: data.total }],
      links: [{ label: 'Open the order', url: data.url }],
    };
  }
}
```

`'ops'` is a named destination. The environment says where it points and which provider formats the message:

```sh title=".env"
CHAT_DRIVER=slack
CHAT_WEBHOOKS=ops=https://hooks.slack.com/services/…
```

## Installation

Add the package with [`marmeon add`](packages.md#introduction), which installs it at the version of your app and lets the app find its provider:

```sh
pnpm marmeon add chat-notifications
```

Where [`marmeon add`](packages.md#packages-you-add) refuses (yarn, bun, a workspace and the other cases listed there), run `pnpm add -E @marmeon/chat-notifications@<version of your app>`, then `marmeon discover`.

The package brings `@marmeon/fetch`, which posts the requests. Queueing a message, and with it the `chat` channel of
notifications, needs `@marmeon/queue` and `APP_KEY`. Without a queue you post with `send()`. The `chat` channel needs
`@marmeon/notifications` as well.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `CHAT_DRIVER` | `log` | The provider's format: `slack`, `discord` or `teams`, or the name of a driver a package brings (see [Chat drivers](drivers.md#chat-drivers)). It formats the named destinations of `CHAT_WEBHOOKS` and every address that names no driver of its own. `log` sends nothing. |
| `CHAT_WEBHOOKS` | empty | Named destinations as `name=address` entries, separated by commas: `ops=https://…,alerts=https://…`. A name starts with a lowercase letter and goes on with lowercase letters, digits and dashes. |

`CHAT_DRIVER=log` is the default, like `MAIL_DRIVER=log`: a message is checked and then only written to the log, with its
destination and title. In development and tests the log also shows the text and the fields. A protected environment, which is
production or a missing `NODE_ENV`, writes neither text nor fields and warns once at the start that nothing is sent. `log` sends nothing in
every case, also to a destination that names a driver of its own. Switch to a provider on purpose in the environment that
should post.

The start stops with [`S10`](errors.md#server-error-codes) when:

- `CHAT_DRIVER` names a driver nobody brought.
- An entry of `CHAT_WEBHOOKS` is not `name=address`, or a name is listed twice.
- An address of `CHAT_WEBHOOKS` is not one the selected driver accepts. With `CHAT_DRIVER=log` there is no driver to check against.
- The driver of a package breaks its contract.
- The `FetchServiceProvider` of `@marmeon/fetch` is missing.

The message of the error names the entry and the host, never the address.

> [!WARNING]
> A webhook address is a secret: whoever has it can post to your channel. Keep it out of the repository and out of
> `.env.example`, set it in the environment of the server, and rotate it in the provider when it leaked. The package writes
> no address to a log line or an error message, and the redactor masks the three shapes of the built-in providers wherever
> they turn up.

## Writing a message

A message has a destination, a text and, if you want them, a title, fields and links. Every part is plain text:

```ts title="modules/orders/notifications/alerts.ts"
import type { ChatMessage } from '@marmeon/chat-notifications';

export const failedPayment = (order: string, reason: string, url: string): ChatMessage => ({
  to: 'ops',
  title: 'Payment failed',
  text: `The payment of order ${order} was declined.`,
  fields: [
    { label: 'Order', value: order },
    { label: 'Reason', value: reason },
  ],
  links: [{ label: 'Open the order', url }],
});
```

| Part | Rules |
| --- | --- |
| `title` | One line, cut at 150 characters. |
| `text` | Required, cut at 2000 characters. Slack also uses it as the text of the push notification. |
| `fields` | At most 10 pairs. The label must not be empty and is cut at 50 characters, the value is cut at 300. |
| `links` | At most 5. The address is `http` or `https` without credentials, the label is cut at 75 characters. |

A text that is too long is cut with `…`, never refused: the data of a message often comes from your users, and a message that
failed because of its length would drop an alert. Each driver cuts once more, after escaping, to the limits of its provider.
A shape you wrote in code is refused with a `ChatError` that names the field, never its value: an empty `text`, an empty label,
too many fields or links, an address that is no address, or one that is not `http` or `https` or that carries credentials. A link
whose address is longer than 2000 characters is left out. An app that builds links from user input validates them first.

Put an address in `links`. Discord shows an address inside the text as text, not as a link.

## Destinations

`to` is a name from `CHAT_WEBHOOKS`, or an object with the address of a recipient. A name that `CHAT_WEBHOOKS` does not list is a
`ChatError` where you call, and so is a destination that is none of the two.

A customer who connects their own channel gives your app an address. Keep it with the recipient and return it from `toChat()`
with the driver that formats for it:

```ts title="modules/orders/notifications/OrderShippedNotification.ts"
import type { ChatMessage } from '@marmeon/chat-notifications';
import type { Notification, NotificationData } from '@marmeon/notifications';
import { rules as r } from '@marmeon/validation';
import type { ChatUser } from '../../auth/UserRepository.ts';

export class OrderShippedNotification implements Notification<'user'> {
  static readonly notification = 'orders.shipped';
  static readonly schema = r.object({ number: r.string() });

  via(user: ChatUser) {
    return user.chat_webhook == null ? ([] as const) : (['chat'] as const);
  }

  toChat(user: ChatUser, data: NotificationData<typeof OrderShippedNotification>): ChatMessage {
    return { to: { url: user.chat_webhook as string, driver: user.chat_provider ?? undefined }, text: `Order ${data.number} has shipped.` };
  }
}
```

`toChat()` gets the recipient as it is now, read when the delivery runs. Mark the column `.secret()` in the migration and,
where your database allows it, store it encrypted (see [encryption](encryption.md)). A secret column is never part of
`selectAll()`, so the repository that the recipient resolver calls in `find()` reads it with `secret()`, in the one place that
needs it. `via()` then tests the value:

```ts title="modules/auth/UserRepository.ts"
import { type Row, Repository, secret } from '@marmeon/database';

/** A user with the chat address, which `Row<'users'>` leaves out. */
export type ChatUser = Row<'users'> & { chat_webhook: string | null };

export class UserRepository extends Repository<'users'> {
  static table = 'users' as const;

  /** What `UserRecipients.find()` returns: the user and, next to it, the secret column. */
  findWithChatWebhook(id: number): Promise<ChatUser | undefined> {
    return this.query().selectAll().select((eb) => secret(eb, 'chat_webhook')).where('id', '=', id).executeTakeFirst();
  }
}
```

`chat_provider` is a nullable column too, so the notification passes `?? undefined`: `driver: null` is refused as a malformed
message, while an absent `driver` leaves the choice to `CHAT_DRIVER`.

The `driver` of a destination comes from your code or from a list you validated, such as a column with the values `slack`,
`discord` and `teams`. Never take it from what a user typed: a name that no driver has fails the delivery at once.

An address that a user enters is checked where they enter it. `chat.check(to)` returns why a destination is refused, or
`undefined`. It judges the address by the rule of the destination's driver and makes no request. Check the address with the
driver that `toChat()` will return, never with raw input: the provider comes from a fixed list, and the rule of the object
reports at the `url` field.

```ts title="modules/settings/requests/ConnectChatRequest.ts"
import { ChatNotifier } from '@marmeon/chat-notifications';
import { defineRequest } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const ConnectChatRequest = defineRequest({
  schema: r
    .object({
      provider: r.in(['slack', 'discord', 'teams']),
      url: r.string().trim(),
    })
    .custom(({ url, provider }, { request }) => request!.resolve(ChatNotifier).check({ url, driver: provider }) ?? true, { field: 'url' }),
});
```

An address that a recipient entered and that its driver refuses is data, not a mistake of your code. The `chat` channel of
notifications skips that chat message and writes one warning that names the host of the address, or says "a webhook address that is not a URL" when there is none to name. The other channels of the delivery
commit. This holds for an empty or an over-long address as well. A mistake in your code or configuration fails the delivery at
once, as a `NotificationChannelError` that retries cannot fix: a name `CHAT_WEBHOOKS` does not list, an unknown driver, a malformed
message or raw format, or an app without a queue. A driver of a package that threw is retried.

## Sending without notifications

Ask for `ChatNotifier` in a constructor to send a message from anywhere else:

```ts title="modules/orders/OrderService.ts"
import { ChatNotifier } from '@marmeon/chat-notifications';
import { failedPayment } from './notifications/alerts.ts';

export class OrderService {
  readonly #chat: ChatNotifier;

  constructor(chat: ChatNotifier) {
    this.#chat = chat;
  }

  async declined(order: string, reason: string, url: string): Promise<void> {
    await this.#chat.queue(failedPayment(order, reason, url));
  }
}
```

`queue(message, options?)` checks the message and the destination at once, then queues the encrypted job `marmeon.chat`.
`options` takes the `queue`, the `connection` and a `delay`. A mistake throws a `ChatError` where you call it, and a worker
posts the message with retries of its own. With a database queue on the connection of a transaction, the job commits with it.

`send(message)` posts now and resolves when the webhook took the message. It throws a `ChatDeliveryError` when the provider
did not take it, with a `reason` of `refused`, `rejected`, `gone`, `throttled` or `unavailable`, and the `status`.

> [!WARNING]
> Inside a transaction `send()` posts before the commit, and a rollback does not take the message back. Use `queue()` there.

Both methods check what a driver would refuse before any request is made. A raw format that the destination's driver does not
take, and a `raw` key that names no driver, throw a `ChatError` where you call them.

## Delivery and retries

A worker posts the queued message. `marmeon.chat` is a framework job: its payload is encrypted with `APP_KEY`, bound to the
job's name, so `jobs` and `failed_jobs` keep only ciphertext and a payload of another job does not run as this one. The
worker checks the message and the address again before it posts, since a payload is data and not a promise. The
[queues](queues.md#secrets-in-payloads) page explains encrypted payloads.

| The webhook answers | What happens |
| --- | --- |
| 2xx | Done. Teams answers `202`: its flow accepted the message and posts it a moment later. |
| 429, 503 | The job waits for the `Retry-After` of the answer, at least one second and at most an hour, and tries again. Without a usable header the backoff applies. |
| Any other 5xx, 408, 425, a timeout, a network error | Tried again with the backoff. |
| An address the `HttpClient` refuses | Fails at once. |
| 404, 410 | Fails at once: the webhook was deleted or disabled. |
| Any other 4xx, a redirect | Fails at once: the provider refused the message, and a redirect is never followed. |

The job has five tries and waits 10, 60, 300 and 300 seconds between them, and times out after 30 seconds. Delivery
is at least once, so a retry after a lost answer can post a message twice. The `failed_jobs` entry names the provider and the
status, and the provider's own error code when it is a short word, never an address.

## Untrusted content

The data in a message often comes from users: a name, a note, an order reference. Each driver shows it as plain text, so it can
neither ping a channel nor smuggle in a link. Bidirectional control characters and other control characters are removed from
every text first.

| Driver | What it does |
| --- | --- |
| Slack | Puts the text into `plain_text` objects, which Slack does not parse. The fallback text is `mrkdwn`, so it is escaped: `&`, `<` and `>` stay text, and mentions and `<url\|label>` links do not work. It sets no `link_names` and turns off unfurling. |
| Discord | Sends one embed with every text escaped, so mentions, masked links and Markdown stay text, and an `@everyone` or `@here` is broken. An address in free text is escaped, `\://`, and shows as text. `allowed_mentions` is empty, so nothing pings. A link address longer than 512 characters, which a button cannot take, becomes a field with `<address>`, or `…` when that does not fit. |
| Teams | Builds the card from `RichTextBlock` and `TextRun`, which do not process Markdown, breaks every `](`, and adds no mention entities, so `<at>` stays text. A card above 28 KB is made smaller: the text goes first, down to 200 characters, then the links, then the field values. |

A user who controls a text cannot ping anybody through the neutral message. A mention on purpose is possible only in a raw
format.

## Raw formats

A message can carry the format of one provider under `raw`, for a feature the neutral message does not have. The driver that
sends uses it instead of its own rendering, and every other driver ignores it:

```ts title="modules/orders/notifications/deploy.ts"
import { escapeSlackText, type ChatMessage } from '@marmeon/chat-notifications';

export const deploy = (version: string): ChatMessage => ({
  to: 'ops',
  text: `Version ${version} is live.`,
  raw: {
    slack: {
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Deploy* of \`${escapeSlackText(version)}\` finished.` } }],
    },
  },
});
```

| Key | Shape |
| --- | --- |
| `raw.slack` | `{ blocks }`: the Block Kit blocks of an incoming webhook. The neutral `text` stays the fallback of the notification. |
| `raw.discord` | `{ content?, embeds?, components?, allowedMentions? }`, at least one of the first three. `components` are rows of link buttons only. `allowedMentions` is `{ everyone?, users?, roles? }`: `everyone: true` lets `@everyone` and `@here` ping, `users` and `roles` take `'all'` or a list of at most 100 ids. Without it nobody is pinged. |
| `raw.teams` | `{ card }`: an Adaptive Card. The driver wraps it in the message the Workflows trigger takes. A card above 28 KB is refused. |

A raw format is JSON of at most 10 000 values and 64 KB. A property whose value is `undefined` is left out, as `JSON.stringify`
does. The driver checks the shape and refuses a field it does not know, with a `ChatError` that names the path, never a
value.

> [!WARNING]
> A raw format is sent as you wrote it, so it can ping and link on purpose. It is not escaped. Escape the data you put into it:
> `escapeSlackText()` for the text of a Slack block, `escapeDiscordMarkdown()` for Discord. In a Teams card put data into
> `RichTextBlock` and `TextRun`, never into a `TextBlock` or a `Fact`, which process Markdown.

## Providers

**Slack.** Create an app, switch on "Incoming Webhooks" and add a webhook for a channel. The address starts with
`https://hooks.slack.com/services/`.

**Discord.** Open the channel's settings, then Integrations, then Webhooks, and create one. The address starts with
`https://discord.com/api/webhooks/`. The hosts `discordapp.com`, `canary.discord.com` and `ptb.discord.com` work as well.

**Microsoft Teams.** The connectors of Office 365 are retired. Create a Workflows flow with the template "Send webhook alerts to a
channel", or one with the trigger "When a Teams webhook request is received", and copy its address. It lives on a host of
`environment.api.powerplatform.com`. The messages show as the Workflows bot. An old address on `logic.azure.com` is refused: at the start
in `CHAT_WEBHOOKS` under `CHAT_DRIVER=teams`, and where a message is sent otherwise.

Every provider's limit holds after escaping, and the driver cuts to it:

| | Slack | Discord | Teams |
| --- | --- | --- | --- |
| Title | 150 | 256 | whole card |
| Text | 3000 | 4096 | whole card |
| Field | 2000 | name 256, value 1024 | whole card |
| Link label | 75 | 80 | whole card |
| Whole message | | 6000 | 28 KB |

Slack allows about one message per second per webhook, Teams four per second. A provider that is faster than that answers
`429`, and the job waits.

A webhook address is accepted only in the form `https://host/path`: no spaces, quotes or backslashes, and no port other than
443. The host and the beginning of the path must belong to the driver, and the request goes through the
[`HttpClient`](http-client.md), which refuses private addresses. A package can add a provider with its own driver, as
[Chat drivers](drivers.md#chat-drivers) shows.

## Testing

A test app replaces `ChatNotifier` with a fake: `app.chat`. A message is checked as for real and recorded, and nothing is posted,
so no request leaves the test. A test uses a made-up address in the driver's shape, because nothing is posted. `send()` and `queue()` are recorded apart, and a notification with the `chat` channel is recorded
as queued when `app.notifications.deliver()` delivers it:

```ts title="modules/orders/payment-alert.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('queues a message for the ops channel', async () => {
  const app = await createTestApp(application, { env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: 'ops=https://hooks.slack.com/services/test-ops' } });
  await app.chat.queue({ to: 'ops', title: 'Payment failed', text: 'Order o-1 was declined.' });
  app.chat.assertQueued({ to: 'ops', title: 'Payment failed' });
});
```

`assertSent`, `assertQueued`, their counts and `assertNothingSent` and `assertNothingQueued` check the rest, as the
[fakes](fakes.md#chat) page lists. `createTestApp(app, { chat: 'real' })` keeps the real notifier, and then `app.http` answers the
webhook's request and `app.queue.work()` runs the queued job.
