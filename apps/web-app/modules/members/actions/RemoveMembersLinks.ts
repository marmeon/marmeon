import { ProfileLinkRepository } from '#modules/user-profile';

/** Bulk action of the members table: removes the links of every member the policy allowed (at most the table's `max`). */
export class RemoveMembersLinks {
  readonly #links: ProfileLinkRepository;

  constructor(links: ProfileLinkRepository) {
    this.#links = links;
  }

  async handle(members: readonly { readonly id: number }[]) {
    return { removed: await this.#links.removeAllOf(members.map((member) => member.id)) };
  }
}
