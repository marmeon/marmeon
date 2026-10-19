import { EmailChange, type Authenticated } from '@marmeon/auth';
import { Clock } from '@marmeon/core';
import { Controller, type HttpContext } from '@marmeon/http';
import { Storage } from '@marmeon/storage';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

/** Where a user's export lies on the private `local` disk — one per user (`DeleteDataExport` removes it with the account). */
export const dataExportKey = (userId: number): string => `exports/user-${userId}.json`;

/**
 * "Download my data": the signed-in user's account and profile links as JSON, written to the **private** `local` disk and
 * handed out through a signed URL that works for five minutes — the browser downloads it (a JSON file is never shown on
 * the app's origin). One file per user, replaced by the next export. Behind the password confirmation, like the
 * security page it is started from.
 */
export class ExportMyDataController extends Controller {
  readonly #links: ProfileLinkRepository;
  readonly #emailChange: EmailChange;
  readonly #storage: Storage;
  readonly #clock: Clock;

  constructor(links: ProfileLinkRepository, emailChange: EmailChange, storage: Storage, clock: Clock) {
    super();
    this.#links = links;
    this.#emailChange = emailChange;
    this.#storage = storage;
    this.#clock = clock;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const { user } = ctx;
    const links = await this.#links.query().select(['label', 'url', 'created_at']).where('user_id', '=', user.id).orderBy('created_at').orderBy('id').execute();
    // The address the user asked for and has not confirmed is theirs to take along; it lives in `email_changes`, not in `users`.
    const pending = await this.#emailChange.waiting();
    const data = {
      exported_at: new Date(this.#clock.now()).toISOString(),
      account: { id: user.id, name: user.name, email: user.email, locale: user.locale, email_verified_at: user.email_verified_at, first_verified_at: user.first_verified_at, pending_email: pending?.email ?? null, created_at: user.created_at },
      profile: { bio: user.bio, links },
    };
    const disk = this.#storage.disk('local');
    const key = dataExportKey(user.id);
    await disk.put(key, JSON.stringify(data, null, 2), { contentType: 'application/json' });
    return this.redirect(await disk.temporaryUrl(key, { expiresIn: { minutes: 5 }, filename: `my-data-${user.id}.json` }), 303);
  }
}
