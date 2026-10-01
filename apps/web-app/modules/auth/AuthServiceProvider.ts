import { UserProvider } from '@bespokecore/auth';
import type { Container, ServiceProvider } from '@bespokecore/core';
import { UserRepository } from './UserRepository.ts';

export class AuthServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(UserRepository);
    // Authentication finds users through the repository (E24).
    container.bind(UserProvider, (c) => c.make(UserRepository));
  }
}
