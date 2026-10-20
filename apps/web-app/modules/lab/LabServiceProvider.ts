import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class LabServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // The devtools form is open to everyone while the lab is on: 30 a minute per client.
    app.container.make(RateLimiter).for('lab.devtools', (ctx) => Limit.perMinute(30).by(clientKey(ctx.ip)));
  }
}
