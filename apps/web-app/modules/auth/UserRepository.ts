import { allUsers, findUser, type User } from './users.ts';

/**
 * Read access to users — the module's public, injectable API.
 * Backed by the in-memory store until the database layer (Wave 3) exists.
 */
export class UserRepository {
  find(id: string): User | undefined {
    return findUser(id);
  }

  all(): readonly User[] {
    return allUsers();
  }
}
