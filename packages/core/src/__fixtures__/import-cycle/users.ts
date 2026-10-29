// Imports billing.ts, which imports this file back: when billing.ts is evaluated, UserRepository is not defined yet.
import { Billing } from './billing.ts';

export class UserRepository {
  static inject = [] as const;
}

export class ShowUser {
  static inject = [Billing] as const;
  constructor(_billing: Billing) {}
}
