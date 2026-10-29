import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class LocaleServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // The language switcher is open to everyone and writes the session (and a signed-in user's locale): 30 a minute per client.
    app.container.make(RateLimiter).for('locale', (ctx) => Limit.perMinute(30).by(clientKey(ctx.ip)));
    // Questions to a talk: open to everyone too.
    app.container.make(RateLimiter).for('talks', (ctx) => Limit.perMinute(30).by(clientKey(ctx.ip)));
  }
}
