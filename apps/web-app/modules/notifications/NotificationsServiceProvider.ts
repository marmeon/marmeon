import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { DigestSender } from './DigestSender.ts';
import { OptOutRepository } from './OptOutRepository.ts';

export class NotificationsServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(OptOutRepository);
    container.singleton(DigestSender);
  }

  boot(app: Application): void {
    // The one-click unsubscribe is open to whoever holds a signed link, with no session (the confirmation page and the post): 60 a minute per client.
    app.container.make(RateLimiter).for('notifications.unsubscribe', (ctx) => Limit.perMinute(60).by(clientKey(ctx.ip)));
  }
}
