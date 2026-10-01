import { UserProvider } from '@bespokecore/auth';
import { Limit, RateLimiter } from '@bespokecore/cache';
import type { Application, Container, ServiceProvider } from '@bespokecore/core';
import { UserRepository } from './UserRepository.ts';

export class AuthServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(UserRepository);
    // Authentication finds users through the repository (E24).
    container.bind(UserProvider, (c) => c.make(UserRepository));
  }

  boot(app: Application): void {
    // Reset links: a few requests per address (the broker also waits 60 s per e-mail). By IP only —
    // the e-mail is not validated yet when middleware runs (W2 rule: never raw input).
    const limiter = app.container.make(RateLimiter);
    limiter.for('password-reset', (ctx) => Limit.perMinute(5).by(ctx.ip ?? 'unknown'));
    // Resending the verification mail: per signed-in user (the route is behind authenticate()).
    limiter.for('verification', (ctx) => Limit.perMinute(3).by(String((ctx as { user?: { id: number } }).user?.id ?? ctx.ip)));
  }
}
