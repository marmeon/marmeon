import { ProfileLinkRepository } from '#modules/user-profile';

/** Row action of the members table: removes every link of one member's profile (moderation). */
export class RemoveMemberLinks {
  readonly #links: ProfileLinkRepository;

  constructor(links: ProfileLinkRepository) {
    this.#links = links;
  }

  // What it needs of the row: its key (the table checks that its rows have it).
  async handle(member: { readonly id: number }) {
    return { removed: await this.#links.removeAllOf([member.id]) };
  }
}
