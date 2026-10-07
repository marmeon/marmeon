import { abort, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { UserRepository } from '#modules/auth';
import { LabConfig } from '../config.ts';
import { LabController } from './ShowLabPageController.ts';

/** `authorize` of the lab's forms: a 404 unless the lab is on — before the schema runs (it asks the database). */
export class LabGate {
  readonly #enabled: boolean;

  constructor(config: LabConfig) {
    this.#enabled = config.enabled;
  }

  open(): boolean {
    if (!this.#enabled) abort(404);
    return true;
  }
}

/** The rules of @marmeon/validation at work (W10 step 3, E197): one form, every kind of message, in English and German. */
export class ShowValidationLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/Validation', {});
  }
}

export const ValidationLabRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().max(40),
    // Whether an address has an account: told on submit, never in a live validation (E197) — a lab page, off in production.
    email: r.string().trim().lowercase().required().email().max(255).unique(UserRepository, 'email'),
    website: r.url().nullable(),
    age: r.integer().between(1, 150).optional(),
    terms: r.accepted(),
  }),
  // The fields' names in messages, by key — the registration's labels (`Das Feld E-Mail …`).
  attributes: { name: 'auth.register.name', email: 'auth.register.email' },
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

/** Takes the form — valid means nothing more here: nothing is saved. */
export class StoreValidationLabController extends LabController {
  static request = ValidationLabRequest;

  handle(ctx: ContextOf<typeof ValidationLabRequest>) {
    this.enabled();
    return this.redirect('/lab/validation').flash('toast', { kind: 'success', message: `Valid: ${ctx.body.name} <${ctx.body.email}> — nothing was saved.` });
  }
}
