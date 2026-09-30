import { EventDispatcher } from '@bespokecore/core';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import * as v from 'valibot';
import { UserLoggedIn } from '../events/UserLoggedIn.ts';
import { UserRepository } from '../UserRepository.ts';

export const LoginRequest = defineRequest({
  schema: v.object({
    user_id: v.pipe(v.string('Pick a user.'), v.regex(/^\d+$/, 'Pick a user.')),
  }),
});

export class LoginController extends Controller {
  static request = LoginRequest;

  readonly #users: UserRepository;
  readonly #events: EventDispatcher;
  readonly #session: Session;

  constructor(users: UserRepository, events: EventDispatcher, session: Session) {
    super();
    this.#users = users;
    this.#events = events;
    this.#session = session;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const user = this.#users.find(ctx.body.user_id);
    if (!user) return this.back().withErrors({ user_id: ['Unknown user.'] });

    this.#session.regenerate(); // a session id planted before login must not survive it
    this.#session.put('user_id', user.id);
    await this.#events.dispatch(new UserLoggedIn(user));

    return this.redirect().route('user-profile.me');
  }
}
