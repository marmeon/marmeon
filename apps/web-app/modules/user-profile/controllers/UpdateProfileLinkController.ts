import type { Row } from '@marmeon/database';
import { Clock } from '@marmeon/core';
import { conflict, Controller, type ContextOf } from '@marmeon/http';
import { RenameProfileLinkRequest } from './RenameProfileLinkController.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

/**
 * Renames a link from the links page, as a form (`useForm('user-profile.links.update')`) — the page-visit twin of the rename action. When the
 * link changed since the form was opened the save is refused and the form goes back with `form.conflict`: the link as it is now,
 * for the user to compare with what was typed — or nothing, when the link is gone.
 */
export class UpdateProfileLinkController extends Controller {
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
    if (saved === undefined) return conflict(undefined);
    if (!saved.ok) return conflict({ label: saved.error.current.label, savedAt: new Date(saved.error.current.updated_at) });
    return this.redirect().route('user-profile.links.index', { user: ctx.params.user.public_id });
  }
}
