import type { AuthUser } from '@bespokecore/auth';
import { DashboardConfig } from '../config.ts';

/** Who may see what on the dashboard. */
export class DashboardPolicy {
  readonly #config: DashboardConfig;

  constructor(config: DashboardConfig) {
    this.#config = config;
  }

  /** The member numbers: administrators only (`DASHBOARD_ADMINS`). */
  viewMembers(user: AuthUser) {
    return this.#config.admins.includes(user.email.toLowerCase());
  }
}
