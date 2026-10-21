import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class AccountExportServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // Three requests an hour for each user: every one can send a mail to their address.
    app.container.make(RateLimiter).for('account-export', (ctx) => Limit.perHour(3).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
  }
}
