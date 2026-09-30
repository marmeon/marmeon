// The application kernel: service container and constructor injection today; providers,
// config and events follow in Wave 1 (see the roadmap). HTTP concerns live in @bespokecore/http.
export { Container, ContainerError } from './container.ts';
export type { Factory, Resolver } from './container.ts';
export { token } from './token.ts';
export type { Concrete, Constructor, InjectCheck, Key, Resolve, Token } from './token.ts';
export { analyzeInjections, injectConstructorDependencies, insertInjections, InjectionError } from './injection/analyze.ts';
export type { InjectionSite } from './injection/analyze.ts';
export { embedInjections, embedPackageInjections } from './injection/embed.ts';
export type { EmbedPackageOptions } from './injection/embed.ts';
export { Application, createApplication, defineApplication } from './application.ts';
export type { ApplicationOptions } from './application.ts';
export { defineModule } from './module.ts';
export { ConsoleLogger, Logger } from './logger.ts';
export { EventDispatcher, EventRegistry, listen } from './events.ts';
export type { EventClass, Listener, ListenerBinding, ListenerLike } from './events.ts';
export type { LogContext } from './logger.ts';
export { currentRequest, runWithRequest } from './request-context.ts';
export type { RequestInfo } from './request-context.ts';
export { ConfigError, defineConfig, loadEnv, resolveConfig } from './config/config.ts';
export type { ConfigDefinition, ConfigOf } from './config/config.ts';
export type { InferOutput, StandardIssue, StandardResult, StandardSchemaV1 } from './config/standard-schema.ts';
export type { ModuleDefinition } from './module.ts';
export type { ServiceProvider, ServiceProviderClass } from './provider.ts';
export { generateManifest, loadDiscoveredPackages, manifestHash, writeManifest, DiscoveryError } from './discovery/discover.ts';
export type { DiscoveredPackages, DiscoverOptions, DiscoverySummary, Manifest } from './discovery/discover.ts';
export { runtimeConditions } from './discovery/resolve.ts';
