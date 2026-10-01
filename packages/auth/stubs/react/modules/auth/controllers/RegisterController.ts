import { Auth, confirmed, Hasher, password, Registered } from '@bespokecore/auth';
import { EventDispatcher } from '@bespokecore/core';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import * as v from 'valibot';
import { UserRepository } from '../UserRepository.ts';

export const RegisterRequest = defineRequest({
  schema: confirmed(
    v.object({
      name: v.pipe(v.string(trans('auth.validation.name_required')), v.trim(), v.minLength(2, trans('auth.validation.name_min')), v.maxLength(255)),
      // Normalized once, here: stored lower case, so the login (which normalizes the same way) finds it.
      email: v.pipe(v.string(trans('auth.validation.email_required')), v.trim(), v.toLowerCase(), v.maxLength(255), v.email(trans('auth.validation.email_invalid'))),
      password: password(),
      password_confirmation: v.string(trans('auth.validation.password_repeat')),
    }),
  ),
});

export class RegisterController extends Controller {
  static request = RegisterRequest;

  readonly #users: UserRepository;
  readonly #hasher: Hasher;
  readonly #auth: Auth;
  readonly #events: EventDispatcher;
  readonly #translator: Translator;

  constructor(users: UserRepository, hasher: Hasher, auth: Auth, events: EventDispatcher, translator: Translator) {
    super();
    this.#users = users;
    this.#hasher = hasher;
    this.#auth = auth;
    this.#events = events;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RegisterRequest>) {
    const { name, email } = ctx.body;
    // The language the account was made in: its mails (the verification link, first) are in it.
    const user = await this.#users.register({ name, email, password: await this.#hasher.make(ctx.body.password), locale: this.#translator.locale });
    if (!user) throw new ValidationError({ email: [this.#translator.get('auth.validation.email_taken')] }, { name, email });

    await this.#events.dispatch(new Registered(user));
    await this.#auth.login(user);
    return this.redirect().route('dashboard');
  }
}
