/**
 * What the framework's own packages import from the core: injection analysis and embedding, the manifest, the transaction
 * frames and the context of a request, job or task. Not API, can change in any release — an app imports from `@marmeon/core`.
 * @internal
 */
export { CLUSTER_WORKER } from './application.ts';
export { messageBase, publishEnded, trace } from './channels.ts';
export { CSP_NONCE_PLACEHOLDER } from './csp.ts';
export { coreSolutions } from './core-solutions.ts';
export { environmentChecks } from './environment.ts';
export { withCode, withoutCode } from './error-codes.ts';
export { describeError, maskUrlPasswords, REDACTED_KEYS } from './redact.ts';
export { collectDrivers } from './drivers.ts';
export { bindingNameOf } from './definition-edit.ts';
export { loadDiscoveredPackages, writeManifest } from './discovery/discover.ts';
export { belongsTo, isInside } from './discovery/contain.ts';
export { findPackage, printable, resolveExports, runtimeConditions } from './discovery/resolve.ts';
export { startedByReporter } from './error-reports.ts';
export { isQueuedListener } from './events.ts';
export { withFileGuard } from './file-guard.ts';
export { browserSources } from './injection/browser.ts';
export { embedPackageInjections } from './injection/embed.ts';
export { writeInjectionArtifacts } from './injection/artifacts.ts';
export { HTML_KEY, interpolateHtml } from './html.ts';
export { loadEnv } from './config/config.ts';
export { consoleLogsGoToStderr, logContextSourcesOf, sendConsoleLogsToStderr } from './logger.ts';
export { runWithJob, runWithRequest, runWithTask } from './request-context.ts';
export { staticNames } from './static-names.ts';
export { parseSync } from './oxc.ts';
export { sourceComments, stringLiterals } from './string-literals.ts';
export { TransactionFrame, bindTransaction, errOfRollback, followsTransaction, leftTransactionOf, openTransactionOf, rollBackOnErr, runTransaction, transactionOf } from './transaction-context.ts';
export { fillPlaceholders, PreferredLocale } from './translator.ts';
export { marmeonInjection } from './vite.ts';
export { recordStubSet, readStubManifest, STUB_MANIFEST, stubHash } from './stubs/manifest.ts';
