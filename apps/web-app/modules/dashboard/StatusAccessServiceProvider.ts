import type { VerifiableUser } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { StatusAccess } from '@fixtures/status-board';
import { DashboardConfig } from './config.ts';

/** The status board package's area is for the administrators the dashboard knows (`DASHBOARD_ADMINS`), with a confirmed address: anybody can sign up with a listed one. */
export class StatusAccessServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(StatusAccess, (resolver) => {
      const { admins } = resolver.make(DashboardConfig);
      return { allows: (user) => (user as VerifiableUser).email_verified_at != null && admins.includes(user.email.toLowerCase()) };
    });
  }
}
