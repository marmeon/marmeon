import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class MembersServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // The table's actions and exports (an export reads the whole filtered table): 60 a minute per signed-in user.
    app.container.make(RateLimiter).for('members-table', (ctx) => Limit.perMinute(60).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
  }
}
