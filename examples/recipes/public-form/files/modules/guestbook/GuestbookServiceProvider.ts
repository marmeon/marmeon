import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class GuestbookServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // Five entries a minute and twenty a day per client address: enough for a person, too few for a script.
    app.container.make(RateLimiter).for('guestbook', (ctx) => {
      const key = clientKey(ctx.ip);
      return [Limit.perMinute(5).by(key), Limit.perDay(20).by(key)];
    });
  }
}
