# @marmeon/chat-notifications

Chat notifications for Marmeon apps: post a message to Slack, Discord or Microsoft Teams through an incoming webhook, now or queued with retries, selected by `CHAT_DRIVER`. A message is checked and cut to the provider caps, a webhook address is refused unless it is one the driver lists, and `escapeSlackText` and `escapeDiscordMarkdown` make data safe inside a raw format. Not published yet.

MIT licensed.
