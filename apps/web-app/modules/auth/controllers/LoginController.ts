import { EventDispatcher } from '@bespokecore/core';
import { Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { UserLoggedIn } from '../events/UserLoggedIn.ts';
import { UserRepository } from '../UserRepository.ts';

export class LoginController extends Controller {
  readonly #users: UserRepository;
  readonly #events: EventDispatcher;
  readonly #session: Session;

  constructor(users: UserRepository, events: EventDispatcher, session: Session) {
    super();
    this.#users = users;
    this.#events = events;
    this.#session = session;
  }

  async handle(ctx: HttpContext) {
    const { user_id } = await ctx.input();
    const user = this.#users.find(String(user_id ?? ''));
    if (!user) return this.back().with('error', 'Unknown user.');

    this.#session.regenerate(); // a session id planted before login must not survive it
    this.#session.put('user_id', user.id);
    await this.#events.dispatch(new UserLoggedIn(user));

    return this.redirect().route('user-profile.me');
  }
}
