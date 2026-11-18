/**
 * Why a chat message was not delivered: `refused` (the address is not one the driver accepts), `rejected` (the provider
 * refused the message), `gone` (the webhook no longer exists), `throttled` (the provider asked to slow down) or
 * `unavailable` (the provider or the network failed).
 */
export type ChatDeliveryReason = 'refused' | 'rejected' | 'gone' | 'throttled' | 'unavailable';

/** Thrown for a chat message or destination that cannot be sent. The message names what is wrong, never a webhook address. */
export class ChatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChatError';
  }
}

/**
 * Thrown when a driver of JavaScript could not be built (its factory threw) or threw while it rendered: the driver may work next time, so
 * the `chat` channel of notifications retries the delivery. It keeps what the driver threw as `cause` (which may be anything, `undefined`
 * included: tell it by its class). A driver that breaks its contract without throwing is a plain `ChatError`.
 * @internal
 */
export class ChatDriverError extends ChatError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChatDriverError';
  }
}

/**
 * Thrown by `chat.queue()` for an address its driver's rule does not accept. The address is data (a recipient entered it), so the `chat`
 * channel of notifications skips such a message with a warning instead of failing the delivery. Every other `ChatError` is a mistake of
 * the code or the configuration, except a `ChatDriverError`: a driver that threw, which a retry may fix.
 * @internal
 */
export class ChatAddressError extends ChatError {
  constructor(message: string) {
    super(message);
    this.name = 'ChatAddressError';
  }
}

/** Thrown when a webhook did not take a message. Retrying helps for `throttled` and `unavailable` only (see `permanent`). */
export class ChatDeliveryError extends ChatError {
  readonly reason: ChatDeliveryReason;
  declare readonly status?: number;
  declare readonly providerCode?: string;
  declare readonly retryAfterSeconds?: number;

  constructor(
    reason: ChatDeliveryReason,
    message: string,
    options?: { status?: number; providerCode?: string; retryAfterSeconds?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChatDeliveryError';
    this.reason = reason;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.providerCode !== undefined) this.providerCode = options.providerCode;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** True when sending the same message again cannot succeed: `refused`, `rejected` and `gone`. */
  get permanent(): boolean {
    return this.reason === 'refused' || this.reason === 'rejected' || this.reason === 'gone';
  }
}

/**
 * Thrown at the start for a chat setup that cannot work: `CHAT_DRIVER` names a driver nobody brought, `CHAT_WEBHOOKS` has an entry
 * that is not `name=address` or an address its driver refuses, a custom driver breaks its contract, or the `HttpClient` is
 * missing. Its message starts with the code `S10` and never holds a webhook address.
 */
export class ChatSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChatSetupError';
  }
}
