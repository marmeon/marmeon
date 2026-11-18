import type { Logger, Resolver } from '@marmeon/core';
import type { ChatContent } from './message.ts';

/**
 * What a chat message is made of when it travels as JSON: no `undefined`, no functions, no class instances. Declare a value of
 * this type as a type alias or an object literal; an interface has no index signature and does not compile.
 */
export type ChatJson = string | number | boolean | null | readonly ChatJson[] | { readonly [key: string]: ChatJson };

/** The request that posts one message: the JSON body and the query parameters the driver adds to the webhook address. */
export interface ChatRequest {
  /**
   * A type alias or an object literal; an interface has no index signature and does not compile. At most 20 000 values, 128 KB as
   * JSON and 64 levels deep: more is a `ChatError` on `send()` and a refusal at `queue()`.
   */
  readonly json: ChatJson;
  readonly search?: Readonly<Record<string, string>>;
}

/**
 * A chat provider's webhook format. A driver declares `hosts` and `paths`; the webhook guard checks an address against them.
 */
export interface ChatDriver {
  /** Exact host names (`hooks.slack.com`) or every subdomain of one (`*.example.com`, never the bare name). */
  readonly hosts: readonly string[];
  /** Path prefixes of its webhook addresses (`/services/`). */
  readonly paths: readonly string[];
  /** The request for one message; `raw` is `message.raw[<driver name>]`, `undefined` when the message has none, otherwise JSON of a bounded size whose shape is not checked. Pure. Throws `ChatError` for a raw format it refuses. */
  render(content: ChatContent, raw: unknown): ChatRequest;
}

/**
 * What a {@link ChatDriverFactory} is given. The factory runs when `CHAT_DRIVER` selects the driver, at the start, or when a
 * destination first names it.
 */
export interface ChatDriverContext {
  /** The name the driver was registered under, as `CHAT_DRIVER` or a destination's `driver` names it. */
  readonly name: string;
  readonly container: Resolver;
  /** A logger of the `chat` channel. */
  readonly logger: Logger;
}

/**
 * Builds a driver from its registered name, the container and a logger: `static chatDrivers = { mattermost: factory }` on a service
 * provider, selected by `CHAT_DRIVER=mattermost`. See `docs/drivers.md#chat-drivers`.
 */
export type ChatDriverFactory = (context: ChatDriverContext) => ChatDriver;
