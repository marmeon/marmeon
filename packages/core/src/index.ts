// The application kernel: container and injection, providers, configuration, events, environment and redaction.
// HTTP concerns live in @marmeon/http.
export { Container, ContainerError } from './container.ts';
export type { ContainerErrorDetails, ContainerErrorReason, Factory, InjectionWarning, Resolver } from './container.ts';
export { defineSolutions, ErrorSolutions } from './solutions.ts';
export type { Solution, SolutionContext, SolutionDefinition } from './solutions.ts';
export { coreSolutions } from './core-solutions.ts';
export { token } from './token.ts';
export type { Concrete, Constructor, InjectCheck, Key, Resolve, Token } from './token.ts';
export { analyzeInjections, applyInsertions, injectConstructorDependencies, insertInjections, insertionsOf, InjectionError } from './injection/analyze.ts';
export type { InjectionSite, Insertion } from './injection/analyze.ts';
export { staticNames } from './static-names.ts';
export type { StaticName } from './static-names.ts';
export { computeInjectionArtifacts, INJECTIONS_FILE, PrecomputedInjections, writeInjectionArtifacts } from './injection/artifacts.ts';
export type { InjectionsFile } from './injection/artifacts.ts';
export { bindingNameOf, editDefinition, editDefinitionFile, importedBindings } from './definition-edit.ts';
export type { DefinitionEdit, DefinitionEditOutcome, DefinitionImport, ImportedBinding } from './definition-edit.ts';
export { browserSources, isBrowserSource } from './injection/browser.ts';
export { embedInjections, embedPackageInjections, removeEmbeddedInjections } from './injection/embed.ts';
export type { EmbedPackageOptions } from './injection/embed.ts';
export { Application, CLUSTER_WORKER, createApplication, defineApplication } from './application.ts';
export type { ApplicationOptions, ApplicationPhase } from './application.ts';
export { defineModule } from './module.ts';
export { ConsoleLogger, LogContextSources, Logger, logContextSourcesOf } from './logger.ts';
export { DEFAULT_HEALTH_TIMEOUT, HealthChecks } from './health.ts';
export type { HealthCheck, HealthCheckClass, HealthCheckResult, HealthReport } from './health.ts';
export { Clock, durationToMilliseconds, SystemClock, TestClock } from './clock.ts';
export type { Duration } from './clock.ts';
export { fillPlaceholders, Translator } from './translator.ts';
export { EventDispatcher, EventRegistry, isQueuedListener, listen, ListenerQueue, missingListenerQueue } from './events.ts';
export type {
  EventClass,
  EventDispatcherOptions,
  EventObserver,
  EventPayload,
  IsJson,
  Listener,
  ListenerBinding,
  ListenerLike,
  QueueableEvent,
  QueuedListenerClass,
  QueuedListenerOptions,
} from './events.ts';
export { EventFake } from './events-fake.ts';
export type { EventMatch } from './events-fake.ts';
export type { LogContext } from './logger.ts';
export { currentJob, currentLogContext, currentRequest, currentTask, runWithJob, runWithRequest, runWithTask } from './request-context.ts';
export type { JobInfo, RequestInfo, TaskInfo } from './request-context.ts';
export {
  afterCommit,
  afterRollback,
  currentTransaction,
  errOfRollback,
  inTransaction,
  leftTransactionOf,
  openTransactionOf,
  outsideTransaction,
  rollBackOnErr,
  runTransaction,
  TransactionError,
  TransactionFinishedError,
  TransactionFrame,
  transactionOf,
} from './transaction-context.ts';
export { commitAnyway, err, ok } from './result.ts';
export type { Err, Ok, Result } from './result.ts';
export { escapeHtml, Html, html, interpolateHtml, raw } from './html.ts';
export { describeError, ENCRYPTED, MAX_ENTRY_BYTES, redact, REDACTED, REDACTED_KEYS, redactText, Redactor } from './redact.ts';
export type { RedactableQuery } from './redact.ts';
export { ConfigError, defineConfig, loadEnv, resolveConfig } from './config/config.ts';
export { env } from './config/env.ts';
export { EnvironmentConfig } from './config/environment-config.ts';
export type { EnvBlock, EnvMessage, EnvNumber, EnvRead, EnvSchema, EnvString, EnvVariable } from './config/env.ts';
export { DOTENV_MARKER, environment, NODE_ENVIRONMENTS, readEnvFile, resolveEnvironment } from './environment.ts';
export { CSP_NONCE_PLACEHOLDER } from './csp.ts';
export type { NodeEnvironment, NodeEnvironmentName, ResolvedEnvironment } from './environment.ts';
export type { ConfigDefinition, ConfigOf } from './config/config.ts';
export type { InferInput, InferOutput, StandardIssue, StandardOptions, StandardResult, StandardSchemaV1 } from './config/standard-schema.ts';
export type { ModuleDefinition } from './module.ts';
export type { ServiceProvider, ServiceProviderClass } from './provider.ts';
export { generateManifest, loadDiscoveredPackages, manifestHash, manifestPath, writeManifest, DiscoveryError } from './discovery/discover.ts';
export type { DiscoveredPackages, DiscoverOptions, DiscoverySummary, Manifest } from './discovery/discover.ts';
export { runtimeConditions } from './discovery/resolve.ts';
export { withFileGuard } from './file-guard.ts';
export type { FileGuardOptions } from './file-guard.ts';
