# @marmeon/chat-notifications

Chat notifications for Marmeon apps: post a message to Slack, Discord or Microsoft Teams through an incoming webhook, now or queued with retries, as a channel of a notification or on its own. A webhook address is refused unless it belongs to its provider, and a fake records the messages in tests.

## Installation

```sh
pnpm add -E @marmeon/chat-notifications@<version of your app>
pnpm marmeon discover
```

The package brings `@marmeon/fetch`. Queued messages need `@marmeon/queue` and `APP_KEY`, because the queued job is encrypted. The `chat` channel of notifications also needs `@marmeon/notifications`. A webhook address is a secret: keep it in `CHAT_WEBHOOKS`, never in the code.

## A first message

```ts
import { ChatNotifier } from '@marmeon/chat-notifications';

export class Deploys {
  readonly #chat: ChatNotifier;

  constructor(chat: ChatNotifier) {
    this.#chat = chat;
  }

  async done(version: string): Promise<void> {
    await this.#chat.queue({ to: 'ops', title: 'Deploy done', text: `Version ${version} is live.` });
  }
}
```

```sh
CHAT_DRIVER=slack
CHAT_WEBHOOKS=ops=https://hooks.slack.com/services/…
```

## Documentation

- [Chat notifications](https://marmeon.com/docs/chat-notifications)
- [Chat notifications: configuration](https://marmeon.com/docs/chat-notifications#configuration)
- [Chat drivers](https://marmeon.com/docs/drivers#chat-drivers)
- [Fakes: chat](https://marmeon.com/docs/fakes#chat)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
