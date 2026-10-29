import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class MembersServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // The table's actions and exports (an export reads the whole filtered table): 60 a minute per signed-in user.
    const limiter = app.container.make(RateLimiter);
    limiter.for('members-table', (ctx) => Limit.perMinute(60).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
    // The export on top of that: ten a minute per signed-in user. tableRoutes() puts it on the export endpoints alone.
    limiter.for('members-export', (ctx) => Limit.perMinute(10).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
  }
}
