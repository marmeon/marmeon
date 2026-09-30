import type { User } from '../users.ts';

/** Dispatched after a successful login. The auth module does not know who listens. */
export class UserLoggedIn {
  readonly #event = true; // makes the class nominal, so listeners for other events cannot be mixed up
  readonly user: User;
  readonly at: Date;

  constructor(user: User, at = new Date()) {
    this.user = user;
    this.at = at;
  }
}
