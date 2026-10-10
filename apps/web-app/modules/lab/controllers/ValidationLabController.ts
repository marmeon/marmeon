import { failOnDuplicate } from '@marmeon/database';
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

/** Invitation codes, looked up asynchronously — as a table or another service would be: what an async `custom()` asks. */
export class LabInvites {
  static readonly CODES: readonly string[] = ['MARMEON-2026', 'LAB-INVITE'];

  async valid(code: string): Promise<boolean> {
    await Promise.resolve();
    return LabInvites.CODES.includes(code);
  }
}

/** The rules of @marmeon/validation at work: one form, every kind of message, in English and German. */
export class ShowValidationLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/Validation', {});
  }
}

/** What both of the lab's forms take — the rules of a value; the database's ones come per form. */
const fields = {
  name: r.string().trim().required().max(40),
  email: r.string().trim().lowercase().required().email().max(255),
  website: r.url().nullable(),
  age: r.integer().between(1, 150).optional(),
  terms: r.accepted(),
  // A date as `<input type="date">` sends it, a port as a form spells it.
  starts: r.date().optional(),
  port: r.port().optional(),
  // Asked asynchronously (a table, a service): on submit only — an async check never runs live unless it says .live(). An empty
  // field reaches the check as '' (a string's empty value is a value) — no code, nothing to ask.
  invite: r.string().trim().custom(async (code, { request }) => code === '' || (await request!.resolve(LabInvites).valid(code)) || 'This invitation code is unknown.').optional(),
  // An account the form names: it must exist — on submit only, like every database rule (no enumeration while typing).
  inviter: r.email().exists(UserRepository, 'email').optional(),
  kind: r.in(['person', 'company']).default('person'),
};

/** A company needs its VAT number — checked only for one (`when`). */
const company = (data: { kind: 'person' | 'company' }) => data.kind === 'company';
const vat = { vat: r.string().trim().required().regex(/^[A-Z]{2}[0-9A-Z]{8,12}$/, 'A VAT number: two letters, then 8 to 12 letters or digits.') };
// The fields' names in messages, by key — the registration's labels (`Das Feld E-Mail …`).
const attributes = { name: 'auth.register.name', email: 'auth.register.email' };

export const ValidationLabRequest = defineRequest({
  schema: r.object({ ...fields, email: fields.email.unique(UserRepository, 'email') }).when(company, vat),
  attributes,
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

/**
 * The same form without the friendly `unique` — as if a second request had raced past it: the unique index answers, and
 * `failOnDuplicate()` turns its conflict into the same 422, in the request's language and with its `attributes` (the router lends
 * them).
 */
export const RaceValidationLabRequest = defineRequest({
  schema: r.object(fields).when(company, vat),
  attributes,
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

/** A sentinel: the insert of the lab only shows the index at work — it is rolled back every time. */
class RolledBack extends Error {}

/** Takes the form — valid means nothing more here: the account is inserted to meet the unique index, then rolled back. */
abstract class StoresInLab extends LabController {
  readonly #users: UserRepository;

  constructor(config: LabConfig, users: UserRepository) {
    super(config);
    this.#users = users;
  }

  protected async tryInsert(body: { name: string; email: string }): Promise<void> {
    await this.#users
      .transaction(async (users) => {
        // The unique index is the truth (two requests at once): a conflict on `email` is a 422 at the field, the transaction rolled back.
        await failOnDuplicate('email', () => users.insert({ name: body.name, email: body.email, password: 'lab: never saved', locale: 'en' }), body);
        throw new RolledBack();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RolledBack)) throw error;
      });
  }
}

export class StoreValidationLabController extends StoresInLab {
  static request = ValidationLabRequest;

  async handle(ctx: ContextOf<typeof ValidationLabRequest>) {
    this.enabled();
    await this.tryInsert(ctx.body);
    return this.redirect('/lab/validation').flash('toast', { kind: 'success', message: `Valid: ${ctx.body.name} <${ctx.body.email}> — nothing was saved.` });
  }
}

export class RaceValidationLabController extends StoresInLab {
  static request = RaceValidationLabRequest;

  async handle(ctx: ContextOf<typeof RaceValidationLabRequest>) {
    this.enabled();
    await this.tryInsert(ctx.body);
    return this.redirect('/lab/validation').flash('toast', { kind: 'success', message: `Valid: ${ctx.body.name} <${ctx.body.email}> — nothing was saved.` });
  }
}
