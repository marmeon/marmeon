import type { Logger, Resolver } from '@marmeon/core';
import type { ChatContent } from './message.ts';

/**
 * What a chat message is made of when it travels as JSON: no `undefined`, no functions, no class instances. Declare a value of
 * this type as a type alias or an object literal; an interface has no index signature and does not compile.
 */
export type ChatJson = string | number | boolean | null | readonly ChatJson[] | { readonly [key: string]: ChatJson };

/** The request that posts one message: the JSON body and the query parameters the driver adds to the webhook address. */
export interface ChatRequest {
  /** A type alias or an object literal; an interface has no index signature and does not compile. */
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
  /** The request for one message; `raw` is `message.raw[<driver name>]`, `undefined` when the message has none, otherwise unchecked JSON. Pure. Throws `ChatError` for a raw format it refuses. */
  render(content: ChatContent, raw: unknown): ChatRequest;
}

/** What a {@link ChatDriverFactory} is given. */
export interface ChatDriverContext {
  /** The name the driver was registered under. */
  readonly name: string;
  readonly container: Resolver;
  /** A logger. */
  readonly logger: Logger;
}

/** Builds a driver from its registered name, the container and a logger. */
export type ChatDriverFactory = (context: ChatDriverContext) => ChatDriver;
