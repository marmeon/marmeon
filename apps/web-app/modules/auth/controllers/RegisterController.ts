import { Auth, AuthConfig, confirmed, Hasher, password, Registered } from '@bespokecore/auth';
import { EventDispatcher } from '@bespokecore/core';
import { Connections } from '@bespokecore/database';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import { Queue } from '@bespokecore/queue';
import * as v from 'valibot';
import { SendAccountExistsMailJob } from '../jobs/SendAccountExistsMailJob.ts';
import { UserRepository } from '../UserRepository.ts';

const name = v.pipe(v.string(trans('auth.validation.name_required')), v.trim(), v.minLength(2, trans('auth.validation.name_min')), v.maxLength(255));
// Normalized once, here: stored lower case, so the login (which normalizes the same way) finds it.
const email = v.pipe(v.string(trans('auth.validation.email_required')), v.trim(), v.toLowerCase(), v.maxLength(255), v.email(trans('auth.validation.email_invalid')));
const passwords = { password: password(), password_confirmation: v.string(trans('auth.validation.password_repeat')) };

// Private registration (E146, the default): nothing in the schema asks the database — whether an address has an account is never
// told, not when the field is checked live (E62), not on submit. The unique index decides in handle(), out of sight.
const privately = confirmed(v.object({ name, email, ...passwords }));

/** The switch for a request schema: its `resolve` builds classes (AuthConfig is a config, injected into this one). */
export class RegistrationMode {
  readonly private: boolean;

  constructor(config: AuthConfig) {
    this.private = config.privateRegistration;
  }
}

export const RegisterRequest = defineRequest({
  // Picked by the switch, never by the input. With AUTH_PRIVATE_REGISTRATION=false (E193) whether the e-mail is taken is part of
  // the schema (built per request: it asks the database), so the form learns it when the field is checked live (E62) — with the
  // same message as on submit, and never more than a submit tells.
  schema: (resolve) =>
    resolve(RegistrationMode).private
      ? privately
      : confirmed(
          v.objectAsync({
            name,
            email: v.pipeAsync(email, v.checkAsync(async (address) => !(await resolve(UserRepository).emailTaken(address)), trans('auth.validation.email_taken'))),
            ...passwords,
          }),
        ),
});

/**
 * Private registration (E146, the default — `AUTH_PRIVATE_REGISTRATION`): a new address and one that has an account get the same
 * answer, in the same time — "check your inbox". A new account gets the verification mail; the owner of an existing one a note
 * that someone tried to sign up with it. Nobody is signed in here: the new account signs in like any other, and the app's pages
 * ask for a confirmed address (`ConfirmedAddress` in routes.ts, `verified()` in the other modules' routes).
 *
 * With `AUTH_PRIVATE_REGISTRATION=false` (E193) it is Laravel Breeze's: signed in at once, a taken address said as a field error.
 */
export class RegisterController extends Controller {
  static request = RegisterRequest;

  readonly #connections: Connections;
  readonly #users: UserRepository;
  readonly #hasher: Hasher;
  readonly #auth: Auth;
  readonly #events: EventDispatcher;
  readonly #queue: Queue;
  readonly #translator: Translator;
  readonly #private: boolean;

  constructor(connections: Connections, users: UserRepository, hasher: Hasher, auth: Auth, events: EventDispatcher, queue: Queue, translator: Translator, config: AuthConfig) {
    super();
    this.#connections = connections;
    this.#users = users;
    this.#hasher = hasher;
    this.#auth = auth;
    this.#events = events;
    this.#queue = queue;
    this.#translator = translator;
    this.#private = config.privateRegistration;
  }

  async handle(ctx: ContextOf<typeof RegisterRequest>) {
    const { name, email } = ctx.body;
    const locale = this.#translator.locale;
    // Hashed for every sign-up — a taken address too, whose password is thrown away: the hash is what takes the time, so the
    // answer takes as long either way.
    const hash = await this.#hasher.make(ctx.body.password);
    // One transaction (E107): the account and whatever the Registered listeners write join it on their own; the verification
    // mail's listener is queued in it (E109).
    if (this.#private) {
      // Either way one job is queued — the verification mail's listener or the note to the owner — and composed by a worker,
      // never here (a mail rendered in one branch only would show in the time).
      await this.#connections.transaction(async () => {
        const user = await this.#users.register({ name, email, password: hash, locale });
        if (user) await this.#events.dispatch(new Registered(user));
        else await this.#queue.dispatch(SendAccountExistsMailJob, { email, locale }, { queue: 'mail' });
      });
      // The same answer for both: no session, no cookie, no flash — nothing that tells them apart.
      return this.redirect().route('auth.register.sent');
    }

    const user = await this.#connections.transaction(async () => {
      const user = await this.#users.register({ name, email, password: hash, locale });
      if (user) await this.#events.dispatch(new Registered(user));
      return user;
    });
    // Taken after all (two sign-ups at once — the unique index decides): the schema's message.
    if (!user) throw new ValidationError({ email: [this.#translator.get('auth.validation.email_taken')] }, { name, email });
    await this.#auth.login(user);
    return this.redirect().route('user-profile.me');
  }
}
