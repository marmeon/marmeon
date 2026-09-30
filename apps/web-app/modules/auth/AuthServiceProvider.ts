import { Limit, RateLimiter } from '@bespokecore/cache';
import type { Application, Container, ServiceProvider } from '@bespokecore/core';
import { UserRepository } from './UserRepository.ts';

export class AuthServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(UserRepository);
  }

  boot(app: Application): void {
    // Five login attempts per minute for each user from each address (Laravel Breeze's default).
    app.container.make(RateLimiter).for('login', async (ctx) => {
      const { user_id } = await ctx.input();
      return Limit.perMinute(5).by(`${String(user_id ?? '')}|${ctx.ip ?? 'unknown'}`);
    });
  }
}
