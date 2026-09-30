import type { Container, ServiceProvider } from '@bespokecore/core';
import { ProfileActivity } from './ProfileActivity.ts';

export class UserProfileServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(ProfileActivity);
  }
}
