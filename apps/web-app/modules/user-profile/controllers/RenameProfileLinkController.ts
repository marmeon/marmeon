import { can } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Clock } from '@marmeon/core';
import { conflict, Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const RenameProfileLinkRequest = defineRequest({
  schema: r.object({
    label: r.string().trim().required().max(60),
    // The `updated_at` the page loaded the link with: the save is stale when the link changed since.
    seen: r.isoTimestamp().required(),
  }),
  // The profile's owner; the route looks the link up within that user, so another user's link id is a 404.
  authorize: can(ProfilePolicy, 'update', 'user'),
});

/**
 * Renames a link from the page without leaving it (`useAction('user-profile.links.rename')`). When the link changed since the page
 * loaded it, the answer is a conflict: the link as it is now, for the page to compare with what the user typed — or nothing, when the link is gone.
 */
export class RenameProfileLinkController extends Controller {
  static request = RenameProfileLinkRequest;

  readonly #links: ProfileLinkRepository;
  readonly #clock: Clock;

  constructor(links: ProfileLinkRepository, clock: Clock) {
    super();
    this.#links = links;
    this.#clock = clock;
  }

  async handle(ctx: ContextOf<typeof RenameProfileLinkRequest, { user: Row<'users'>; link: Row<'profile_links'> }>) {
    const saved = await this.#links.renameIfCurrent(ctx.params.link.id, ctx.body.label, new Date(ctx.body.seen), new Date(this.#clock.now()));
    // Removed between the lookup of the route and the save: nothing is current any more.
    if (saved === undefined) return conflict(undefined);
    if (!saved.ok) return conflict({ label: saved.error.current.label, savedAt: new Date(saved.error.current.updated_at) });
    return this.json({ label: saved.value.label, updated_at: saved.value.updated_at });
  }
}
