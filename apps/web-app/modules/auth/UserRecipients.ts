import type { RecipientResolver } from '@marmeon/notifications';
import { UserRepository } from './UserRepository.ts';
import type { User } from './users.ts';

/**
 * How notifications find a user again where they are delivered (a worker): by id — gone, nothing is delivered — and in
 * which language the user reads (their mails are composed in it).
 */
export class UserRecipients implements RecipientResolver<'user'> {
  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    this.#users = users;
  }

  find(id: number): Promise<User | undefined> {
    return this.#users.find(id);
  }

  locale(user: User): string | null {
    return user.locale;
  }
}
