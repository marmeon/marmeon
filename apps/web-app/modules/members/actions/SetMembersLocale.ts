import { UserRepository } from '#modules/auth';

/** Bulk action of the members table: sets the language of every member the policy allowed — the value comes from the action's input. */
export class SetMembersLocale {
  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    this.#users = users;
  }

  // The third parameter is the input schema's output: the table checks that the two fit.
  async handle(members: readonly { readonly id: number }[], _ctx: unknown, input: { readonly locale: 'en' | 'de' }) {
    for (const member of members) await this.#users.updateLocale(member.id, input.locale);
    return { updated: members.length };
  }
}
