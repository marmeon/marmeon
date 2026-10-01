import { Auth, confirmed, Hasher, password, Registered } from '@bespokecore/auth';
import { EventDispatcher } from '@bespokecore/core';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import * as v from 'valibot';
import { UserRepository } from '../UserRepository.ts';

export const RegisterRequest = defineRequest({
  schema: confirmed(
    v.object({
      name: v.pipe(v.string('Enter your name.'), v.trim(), v.minLength(2, 'The name needs at least 2 characters.'), v.maxLength(255)),
      // Normalized once, here: stored lower case, so the login (which normalizes the same way) finds it.
      email: v.pipe(v.string('Enter your e-mail address.'), v.trim(), v.toLowerCase(), v.maxLength(255), v.email('Enter a valid e-mail address.')),
      password: password(),
      password_confirmation: v.string('Repeat the password.'),
    }),
  ),
});

export class RegisterController extends Controller {
  static request = RegisterRequest;

  readonly #users: UserRepository;
  readonly #hasher: Hasher;
  readonly #auth: Auth;
  readonly #events: EventDispatcher;

  constructor(users: UserRepository, hasher: Hasher, auth: Auth, events: EventDispatcher) {
    super();
    this.#users = users;
    this.#hasher = hasher;
    this.#auth = auth;
    this.#events = events;
  }

  async handle(ctx: ContextOf<typeof RegisterRequest>) {
    const { name, email } = ctx.body;
    const user = await this.#users.register({ name, email, password: await this.#hasher.make(ctx.body.password) });
    if (!user) throw new ValidationError({ email: ['This e-mail address is already registered.'] }, { name, email });

    await this.#events.dispatch(new Registered(user));
    await this.#auth.login(user);
    return this.redirect().route('user-profile.me');
  }
}
