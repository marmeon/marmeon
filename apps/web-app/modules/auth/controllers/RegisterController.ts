import { Auth, confirmed, Hasher, password, Registered } from '@bespokecore/auth';
import { EventDispatcher } from '@bespokecore/core';
import { Connections } from '@bespokecore/database';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import * as v from 'valibot';
import { UserRepository } from '../UserRepository.ts';

export const RegisterRequest = defineRequest({
  // Built per request (it asks the database): whether the e-mail is taken is part of the schema, so the form learns it when
  // the field is checked live (E62) — with the same message as on submit, and never more than a submit tells.
  schema: (resolve) =>
    confirmed(
      v.objectAsync({
        name: v.pipe(v.string(trans('auth.validation.name_required')), v.trim(), v.minLength(2, trans('auth.validation.name_min')), v.maxLength(255)),
        // Normalized once, here: stored lower case, so the login (which normalizes the same way) finds it.
        email: v.pipeAsync(
          v.string(trans('auth.validation.email_required')),
          v.trim(),
          v.toLowerCase(),
          v.maxLength(255),
          v.email(trans('auth.validation.email_invalid')),
          v.checkAsync(async (email) => !(await resolve(UserRepository).emailTaken(email)), trans('auth.validation.email_taken')),
        ),
        password: password(),
        password_confirmation: v.string(trans('auth.validation.password_repeat')),
      }),
    ),
});

export class RegisterController extends Controller {
  static request = RegisterRequest;

  readonly #connections: Connections;
  readonly #users: UserRepository;
  readonly #hasher: Hasher;
  readonly #auth: Auth;
  readonly #events: EventDispatcher;
  readonly #translator: Translator;

  constructor(connections: Connections, users: UserRepository, hasher: Hasher, auth: Auth, events: EventDispatcher, translator: Translator) {
    super();
    this.#connections = connections;
    this.#users = users;
    this.#hasher = hasher;
    this.#auth = auth;
    this.#events = events;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RegisterRequest>) {
    const { name, email } = ctx.body;
    const hash = await this.#hasher.make(ctx.body.password);
    // One transaction (E107): the account and whatever the Registered listeners write join it on their own. A listener
    // that fails leaves no account behind; mails wait for the commit (afterCommit in the listener).
    const user = await this.#connections.transaction(async () => {
      // The language the account was made in: its mails (the verification link, first) are in it.
      const user = await this.#users.register({ name, email, password: hash, locale: this.#translator.locale });
      if (user) await this.#events.dispatch(new Registered(user));
      return user;
    });
    // Taken after all (two sign-ups at once — the unique index decides): the schema's message.
    if (!user) throw new ValidationError({ email: [this.#translator.get('auth.validation.email_taken')] }, { name, email });

    await this.#auth.login(user);
    return this.redirect().route('user-profile.me');
  }
}
