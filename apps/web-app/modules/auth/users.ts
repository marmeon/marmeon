export interface User {
  id: string;
  name: string;
  email: string;
  bio: string;
}

// In-memory stand-in until the database layer exists.
const users: readonly User[] = [
  { id: '1', name: 'Ada Lovelace', email: 'ada@example.com', bio: 'First programmer.' },
  { id: '2', name: 'Alan Turing', email: 'alan@example.com', bio: 'Computability pioneer.' },
];

export function findUser(id: string): User | undefined {
  return users.find((user) => user.id === id);
}
