import type { AuthUser } from '@marmeon/auth';
import { DashboardConfig } from '#modules/dashboard';

/** Who may do what in the members table. Administrators are the dashboard's (`DASHBOARD_ADMINS`). */
export class MemberPolicy {
  readonly #config: DashboardConfig;

  constructor(config: DashboardConfig) {
    this.#config = config;
  }

  /** See the e-mail addresses: administrators only — for everyone else the column is not even selected. */
  viewEmails(user: AuthUser) {
    return this.#isAdmin(user);
  }

  /** Moderate (remove profile links): administrators only — for everyone else the actions are not offered. */
  moderate(user: AuthUser) {
    return this.#isAdmin(user);
  }

  /** Remove a member's links: an administrator, and not their own (those they edit on their profile). */
  removeLinks(user: AuthUser, member: { readonly id: number }) {
    return this.#isAdmin(user) && member.id !== user.id;
  }

  /** Export the list as CSV: administrators only. */
  export(user: AuthUser) {
    return this.#isAdmin(user);
  }

  #isAdmin(user: AuthUser): boolean {
    return this.#config.admins.includes(user.email.toLowerCase());
  }
}
