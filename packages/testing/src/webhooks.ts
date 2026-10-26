import type { WebhookScheme } from '@marmeon/http';
import { signWebhook } from '@marmeon/http/internal';

export interface SignedWebhookOptions {
  /** The format the sender signs in. */
  scheme: WebhookScheme;
  /** The secret as the sender shows it (`whsec_…` for `standard`). */
  secret: string;
  /** The delivery id; random unless given. `stripe` sends none. */
  id?: string;
  /** When the sender signed; now unless given. `github` sends no time. */
  timestamp?: Date;
}

/**
 * The headers a webhook sender would send for `body`, signed as `options` say —
 * spread them into the request to test a route behind `verifyWebhook()`. Sign the exact string that is sent. See
 * `docs/webhooks.md#testing`.
 */
export function signedWebhook(body: string, options: SignedWebhookOptions): Record<string, string> {
  const { scheme, secret, ...rest } = options;
  return signWebhook(scheme, secret, body, rest);
}
