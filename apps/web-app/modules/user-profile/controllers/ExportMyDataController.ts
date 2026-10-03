import type { Authenticated } from '@bespokecore/auth';
import { Clock } from '@bespokecore/core';
import { Controller, type HttpContext } from '@bespokecore/http';
import { Storage } from '@bespokecore/storage';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

/**
 * "Download my data": the signed-in user's account and profile links as JSON, written to the **private** `local` disk and
 * handed out through a signed URL that works for five minutes — the browser downloads it (a JSON file is never shown on
 * the app's origin). One file per user, replaced by the next export. Behind the password confirmation, like the
 * security page it is started from.
 */
export class ExportMyDataController extends Controller {
  readonly #links: ProfileLinkRepository;
  readonly #storage: Storage;
  readonly #clock: Clock;

  constructor(links: ProfileLinkRepository, storage: Storage, clock: Clock) {
    super();
    this.#links = links;
    this.#storage = storage;
    this.#clock = clock;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const { user } = ctx;
    const links = await this.#links.query().select(['label', 'url', 'created_at']).where('user_id', '=', user.id).orderBy('id').execute();
    const data = {
      exported_at: new Date(this.#clock.now()).toISOString(),
      account: { id: user.id, name: user.name, email: user.email, locale: user.locale, email_verified_at: user.email_verified_at, created_at: user.created_at },
      profile: { bio: user.bio, links },
    };
    const disk = this.#storage.disk('local');
    const key = `exports/user-${user.id}.json`;
    await disk.put(key, JSON.stringify(data, null, 2), { contentType: 'application/json' });
    return this.redirect(await disk.temporaryUrl(key, { expiresIn: { minutes: 5 }, filename: `my-data-${user.id}.json` }), 303);
  }
}
