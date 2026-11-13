import type { Container, ServiceProvider } from '@marmeon/core';
import { StatusAccess } from '@fixtures/status-board';
import { DashboardConfig } from './config.ts';

/** The status board package's area is for the administrators the dashboard knows (`DASHBOARD_ADMINS`). */
export class StatusAccessServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(StatusAccess, (resolver) => {
      const { admins } = resolver.make(DashboardConfig);
      return { allows: (user) => admins.includes(user.email.toLowerCase()) };
    });
  }
}
