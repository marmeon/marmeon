/**
 * The exceptions to the two rules about `./internal` that `pnpm api:check` enforces (`scripts/api.ts`; CONTRIBUTING.md, "The API
 * snapshot"): every name of an `./internal` entry is imported by a file outside its package, and every class that a public
 * signature names is exported by an entry point. A key is `<specifier of the entry> <name>` for the first rule and
 * `<package> <class>` for the second.
 */

/** Names that stand on purpose. Each says why; nothing else belongs here. */
export const INTERNAL_EXCEPTIONS: Readonly<Record<string, string>> = {};

/**
 * Names that do not follow the rules yet. Each change that fixes one deletes its line; the list is empty before a release.
 */
export const INTERNAL_PENDING: ReadonlySet<string> = new Set<string>([
  '@marmeon/core/internal DiscoverOptions',
  '@marmeon/core/internal DiscoveredPackages',
  '@marmeon/core/internal DiscoverySummary',
  '@marmeon/core/internal EmbedPackageOptions',
  '@marmeon/core/internal FileGuardOptions',
  '@marmeon/core/internal InjectionPlugin',
  '@marmeon/core/internal Manifest',
  '@marmeon/core/internal PROVIDER_STATICS',
  '@marmeon/core/internal SourceComment',
  '@marmeon/core/internal StaticName',
  '@marmeon/core/internal StringLiteral',
  '@marmeon/core/internal StubFile',
  '@marmeon/core/internal StubManifest',
  '@marmeon/core/internal StubManifestProblem',
  '@marmeon/core/internal StubSet',
  '@marmeon/database/internal MigrationDeclaration',
  '@marmeon/database/internal PackageMigrationFile',
  '@marmeon/database/internal PackageMigrations',
  '@marmeon/database/internal PackageMigrationsError',
  '@marmeon/database/internal ProviderPackage',
  '@marmeon/database/internal Rendered',
  '@marmeon/database/internal assignMigrations',
  '@marmeon/database/internal migrationDeclarations',
  '@marmeon/database/internal readMigrationDirectory',
  '@marmeon/database/internal readProviderMigrations',
  '@marmeon/database/internal unattributedDeclarations',
  '@marmeon/queue/internal ParsedRecord',
  '@marmeon/queue/internal withAvailableAt',
  '@marmeon/router/internal DispatchInput',
  '@marmeon/router/internal RouteCheck',
  '@marmeon/router/internal addsConflicts',
  '@marmeon/router/internal authorizeRequest',
  '@marmeon/router/internal runPipeline',
  '@marmeon/router/internal validateRequest',
  '@marmeon/server/internal DevMarkup',
  '@marmeon/server/internal ViteDevOptions',
  '@marmeon/session/internal SESSION_READERS',
  '@marmeon/validation/internal RuleContents',
  '@marmeon/auth NewPassword',
  '@marmeon/auth SessionFingerprints',
  '@marmeon/auth SignInThrottle',
  '@marmeon/storage StorageManager',
]);
