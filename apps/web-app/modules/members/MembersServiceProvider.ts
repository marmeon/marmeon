import { Limit, RateLimiter } from '@bespokecore/cache';
import type { Application, ServiceProvider } from '@bespokecore/core';

export class MembersServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // The table's actions and exports (an export reads the whole filtered table): 60 a minute per signed-in user.
    app.container.make(RateLimiter).for('members-table', (ctx) => Limit.perMinute(60).by(String((ctx as { user?: { id: number } }).user?.id ?? ctx.ip)));
  }
}
