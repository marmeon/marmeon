import { confirmed, Hasher, password, Registered } from '@bespokecore/auth';
import { EventDispatcher } from '@bespokecore/core';
import { Connections } from '@bespokecore/database';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import { Queue } from '@bespokecore/queue';
import * as v from 'valibot';
import { SendAccountExistsMailJob } from '../jobs/SendAccountExistsMailJob.ts';
import { UserRepository } from '../UserRepository.ts';

export const RegisterRequest = defineRequest({
  // Private registration (E146): nothing in the schema asks the database — whether an address has an account is never told,
  // not when the field is checked live (E62), not on submit. The unique index decides in handle(), out of sight.
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

/**
 * Private registration (`bespoke make:auth --private-registration`, E146): a new address and one that has an account get the
 * same answer, in the same time — "check your inbox". A new account gets the verification mail; the owner of an existing one
 * a note that someone tried to sign up with it. Nobody is signed in here: the new account signs in like any other; what
 * needs a confirmed address asks for it (`verified()` — the members island, links on the profile).
 */
export class RegisterController extends Controller {
  static request = RegisterRequest;

  readonly #connections: Connections;
  readonly #users: UserRepository;
  readonly #hasher: Hasher;
  readonly #events: EventDispatcher;
  readonly #queue: Queue;
  readonly #translator: Translator;

  constructor(connections: Connections, users: UserRepository, hasher: Hasher, events: EventDispatcher, queue: Queue, translator: Translator) {
    super();
    this.#connections = connections;
    this.#users = users;
    this.#hasher = hasher;
    this.#events = events;
    this.#queue = queue;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RegisterRequest>) {
    const { name, email } = ctx.body;
    const locale = this.#translator.locale;
    // Hashed for every sign-up — a taken address too, whose password is thrown away: the hash is what takes the time, so the
    // answer takes as long either way.
    const hash = await this.#hasher.make(ctx.body.password);
    // One transaction (E107). Either way one job is queued — the verification mail's listener or the note to the owner — and
    // composed by a worker, never here (a mail rendered in one branch only would show in the time).
    await this.#connections.transaction(async () => {
      const user = await this.#users.register({ name, email, password: hash, locale });
      if (user) await this.#events.dispatch(new Registered(user));
      else await this.#queue.dispatch(SendAccountExistsMailJob, { email, locale }, { queue: 'mail' });
    });
    // The same answer for both: no session, no cookie, no flash — nothing that tells them apart.
    return this.redirect().route('auth.register.sent');
  }
}
