import { Auth } from '@marmeon/auth';
import type { LiveAuthorizer } from '@marmeon/http';
import { notificationsChannel } from '@marmeon/live';

/**
 * Asked at every connection of a live stream which of its signed channels the request may follow: a notifications channel is
 * its recipient's own, the signed-in account's and nobody else's. It answers `true` for every other channel — those pages
 * decide by their own routes — because a channel is kept only if every authorizer of the app allows it.
 */
export class NotificationsLiveAuthorizer implements LiveAuthorizer {
  readonly #auth: Auth;

  constructor(auth: Auth) {
    this.#auth = auth;
  }

  async allows(channel: string): Promise<boolean> {
    if (!channel.startsWith('notifications.')) return true;
    const user = await this.#auth.user();
    return user !== undefined && channel === notificationsChannel({ type: 'user', id: user.id });
  }
}
