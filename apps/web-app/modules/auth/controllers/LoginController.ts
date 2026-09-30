import { EventDispatcher } from '@bespokecore/core';
import { Controller, type HttpContext } from '@bespokecore/http';
import { UserLoggedIn } from '../events/UserLoggedIn.ts';
import { SESSION_COOKIE } from '../middleware.ts';
import { UserRepository } from '../UserRepository.ts';

export class LoginController extends Controller {
  readonly #users: UserRepository;
  readonly #events: EventDispatcher;

  constructor(users: UserRepository, events: EventDispatcher) {
    super();
    this.#users = users;
    this.#events = events;
  }

  async handle(ctx: HttpContext) {
    const { user_id } = await ctx.input();
    const user = this.#users.find(String(user_id ?? ''));
    if (!user) return this.back();

    await this.#events.dispatch(new UserLoggedIn(user));

    ctx.cookies.set(SESSION_COOKIE, user.id);
    return this.redirect().route('user-profile.me');
  }
}
