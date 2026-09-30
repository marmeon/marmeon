import type { Container, ServiceProvider } from '@bespokecore/core';
import { LoginActivityRepository } from './LoginActivityRepository.ts';

export class UserProfileServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(LoginActivityRepository);
  }
}
