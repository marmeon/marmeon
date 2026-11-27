// Type guarantees of the transport contract — checked by `tsc` (typecheck), never run.
import { expectTypeOf } from 'vitest';
import { MailDeliveryError } from './mailer.ts';
import type { MailMessage } from './message.ts';
import type { MailReceipt, MailSendOptions, MailTransport } from './transports.ts';

// A transport that ignores the options is a transport.
export const plain: MailTransport = {
  async send(_message: MailMessage): Promise<MailReceipt> {
    return { messageId: undefined };
  },
};

export const withOptions: MailTransport = {
  async send(_message: MailMessage, options?: MailSendOptions): Promise<MailReceipt> {
    void options?.signal;
    void options?.idempotencyKey;
    return { messageId: undefined };
  },
};

export const wrong: MailTransport = {
  // @ts-expect-error the second parameter is MailSendOptions, not a number
  async send(_message: MailMessage, _options?: number): Promise<MailReceipt> {
    return { messageId: undefined };
  },
};

declare const transport: MailTransport;
declare const message: MailMessage;
declare const cause: unknown;

// @ts-expect-error a reason outside the five
export const reason = new MailDeliveryError('temporary', 'x');
// @ts-expect-error nothing from the request travels with the error
export const withCause = new MailDeliveryError('rejected', 'x', { cause });
// @ts-expect-error the key is idempotencyKey
export const misspelled = transport.send(message, { idempotency: 'x' });
// @ts-expect-error the signal is an AbortSignal
export const badSignal = transport.send(message, { signal: 1 });

expectTypeOf<MailSendOptions['signal']>().toEqualTypeOf<AbortSignal | undefined>();
