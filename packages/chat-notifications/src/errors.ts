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
