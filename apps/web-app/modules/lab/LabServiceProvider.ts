import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { RecentErrors } from './RecentErrors.ts';

export class LabServiceProvider implements ServiceProvider {
  // The last server errors, kept in memory by an error reporter: `/lab/errors` lists them.
  static errorReporters = [RecentErrors];

  register(container: Container): void {
    // One instance, so the page reads what the reporter got.
    container.singleton(RecentErrors);
  }

  boot(app: Application): void {
    // The devtools form is open to everyone while the lab is on: 30 a minute per client.
    app.container.make(RateLimiter).for('lab.devtools', (ctx) => Limit.perMinute(30).by(clientKey(ctx.ip)));
    app.container.make(RateLimiter).for('lab.one-time-links', (ctx) => Limit.perMinute(30).by(clientKey(ctx.ip)));
    app.container.make(RateLimiter).for('lab.webhook-ping', (ctx) => Limit.perMinute(30).by(clientKey(ctx.ip)));
    // A post to a team's channel: ten a minute per signed-in user.
    app.container.make(RateLimiter).for('lab.chat', (ctx) => Limit.perMinute(10).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
  }
}
