import type { Container, ServiceProvider } from '@bespokecore/core';
import { LoginActivityRepository } from './LoginActivityRepository.ts';
import { MemberStats } from './MemberStats.ts';
import { ProfileLinkRepository } from './ProfileLinkRepository.ts';

export class UserProfileServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(LoginActivityRepository);
    container.singleton(ProfileLinkRepository);
    container.singleton(MemberStats);
  }
}
