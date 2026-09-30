// The application kernel: service container today; providers, config and events
// follow in Wave 1 (see the roadmap). HTTP concerns live in @bespokecore/http.
export { Container, ContainerError } from './container.ts';
export type { Factory, Resolver } from './container.ts';
export { token } from './token.ts';
export type { Concrete, Constructor, InjectCheck, Key, Resolve, Token } from './token.ts';
