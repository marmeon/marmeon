// Public API of the auth module. Other modules import from here, never from internals.
export { authenticate, type AuthState } from './middleware.ts';
export { UserRepository } from './UserRepository.ts';
export type { User } from './users.ts';
export { default as routes } from './routes.ts';
