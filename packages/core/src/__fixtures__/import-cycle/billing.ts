import { UserRepository } from './users.ts';

export class Billing {
  static inject = [UserRepository] as const;
  constructor(_users: UserRepository) {}
}
