import { Auth, AuthConfig, Hasher, password, Registered } from '@marmeon/auth';
import { EventDispatcher } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Queue } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { SendAccountExistsMailJob } from '../jobs/SendAccountExistsMailJob.ts';
import { UserRepository } from '../UserRepository.ts';

const name = r.string().trim().required().min(2).max(255);
// Normalized once, here: stored lower case, so the login (which normalizes the same way) finds it.
const email = r.string().trim().lowercase().required().max(255).email();

/**
 * One schema for both behaviours (E193), and nothing in it asks the database (E197): whether an address has an account is never
 * told when a field is checked live (E62) — a `unique` there would tell anyone who types an address. Private registration (E146,
 * the default) never tells at all; with `AUTH_PRIVATE_REGISTRATION=false` the unique index decides in handle(), and a taken
 * address is said on submit.
 */
export const RegisterRequest = defineRequest({
  schema: r.object({ name, email, password: password(), password_confirmation: r.string() }).confirmed('password'),
  messages: {
    'name.required': 'auth.validation.name_required',
    'name.min': 'auth.validation.name_min',
    'email.required': 'auth.validation.email_required',
    'email.email': 'auth.validation.email_invalid',
    'password_confirmation.required': 'auth.validation.password_repeat',
    'password_confirmation.confirmed': 'auth.validation.passwords_differ',
  },
});

/**
 * Private registration (E146, the default — `AUTH_PRIVATE_REGISTRATION`): a new address and one that has an account get the same
 * answer, in the same time — "check your inbox". A new account gets the verification mail; the owner of an existing one a note
 * that someone tried to sign up with it. Nobody is signed in here: the new account signs in like any other, and the app's pages
 * ask for a confirmed address (`ConfirmedAddress` in routes.ts).
 *
 * With `AUTH_PRIVATE_REGISTRATION=false` (E193) it is Laravel Breeze's: signed in at once, a taken address said as a field error on
 * submit (never live: the schema does not ask, E197).
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
    // Taken — the unique index decides (the schema never asks, E197; two sign-ups at once included): a field error.
    if (!user) throw new ValidationError({ email: [this.#translator.get('auth.validation.email_taken')] }, { name, email });
    await this.#auth.login(user);
    return this.redirect().route('dashboard');
  }
}
