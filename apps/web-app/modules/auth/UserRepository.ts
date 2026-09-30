import type { User } from './users.ts';

/**
 * Access to users — the module's public, injectable API.
 * In-memory until the data layer (Wave 3) exists; registered as a singleton.
 */
export class UserRepository {
  readonly #users: User[] = [
    { id: '1', name: 'Ada Lovelace', email: 'ada@example.com', bio: 'First programmer.' },
    { id: '2', name: 'Alan Turing', email: 'alan@example.com', bio: 'Computability pioneer.' },
    { id: '3', name: 'Grace Hopper', email: 'grace@example.com', bio: 'Compiler inventor.' },
  ];

  find(id: string): User | undefined {
    return this.#users.find((user) => user.id === id);
  }

  all(): readonly User[] {
    return this.#users;
  }

  update(id: string, changes: Partial<Omit<User, 'id'>>): User | undefined {
    const index = this.#users.findIndex((user) => user.id === id);
    if (index === -1) return undefined;
    this.#users[index] = { ...this.#users[index]!, ...changes };
    return this.#users[index];
  }
}
