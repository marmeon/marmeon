import type { VerifiableUser } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { OfficeAccess } from '@fixtures/back-office';
import { UserRepository } from '#modules/auth';
import { DashboardConfig } from '#modules/dashboard';

/**
 * With `BACK_OFFICE_USERS=app` the back office serves the app's users, and the app says who is an editor: the administrators the dashboard
 * knows (`DASHBOARD_ADMINS`), with a confirmed address. Every other customer has no role there. In the default mode (`own`) the back office
 * never asks this: its editors are accounts of `office_users`, and an id of that table is not an id of `users`.
 */
export class OfficeAccessServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(OfficeAccess, (resolver) => {
      const { admins } = resolver.make(DashboardConfig);
      return {
        roleOf: async (id) => {
          const user = await container.make(UserRepository).find(id);
          return user !== undefined && (user as VerifiableUser).email_verified_at != null && admins.includes(user.email.toLowerCase()) ? 'editor' : undefined;
        },
      };
    });
  }
}
