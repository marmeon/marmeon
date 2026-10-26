/**
 * The exceptions to "a class member of a stable entry point is used by an app, the docs or the kit" that `pnpm api:check` enforces
 * (`scripts/api.ts`; CONTRIBUTING.md, "The API snapshot"). A key is `<entry> <Class>.<member>` (`<entry> <Class>.constructor` for the
 * constructor); `<entry> <Class>.*` stands for every member of a class and `<entry> *` for every class of an entry.
 */

/** Members that stay public although no app code calls them. Each says why; nothing else belongs here. */
export const MEMBER_EXCEPTIONS: Readonly<Record<string, string>> = {
  '@marmeon/http/client/adapter *': 'the contract of a client adapter: an adapter for another UI library calls it',
  '@marmeon/table RowAction.handler': 'defineTable infers the handler class from it and checks its handle(row, ctx) against the table\'s row',
  '@marmeon/table BulkAction.handler': 'defineTable infers the handler class from it and checks its handle(rows, ctx) against the table\'s row',
  '@marmeon/table/client TableController.*': 'the React adapter builds the controller and an adapter for another UI library does the same',
};

/**
 * Members that do not follow the rule yet. Each change that fixes one deletes its line; the list is empty before a release.
 */
export const MEMBER_PENDING: readonly string[] = [
  '@marmeon/core Container.constructor',
  '@marmeon/core Container.isScope',
  '@marmeon/core EnvBlock.constructor',
  '@marmeon/core EnvSchema.constructor',
  '@marmeon/core EventRegistry.bindingsFor',
  '@marmeon/core EventRegistry.listenersFor',
  '@marmeon/core/testing EventFake.isFaked',
  '@marmeon/devtools FileDevtoolsStore.directory',
  '@marmeon/devtools FileDevtoolsStore.maxAgeMs',
  '@marmeon/http ClientHistory.cleared',
  '@marmeon/http ClientHistory.siteData',
  '@marmeon/http CloseLayerResult.constructor',
  '@marmeon/http CookieEncryption.isEncrypted',
  '@marmeon/i18n Catalog.formatter',
  '@marmeon/i18n Catalog.namespaces',
  '@marmeon/i18n Catalog.translate',
  '@marmeon/live/testing LiveStreamReader.heartbeats',
  '@marmeon/live/testing LiveStreamReader.retryMs',
  '@marmeon/redis RedisConnections.inUse',
  '@marmeon/router RouteDefinition.blocking',
  '@marmeon/router RouteDefinition.inSitemap',
  '@marmeon/router RouteDefinition.isInternal',
  '@marmeon/router RouteDefinition.routeName',
  '@marmeon/router Router.findByName',
  '@marmeon/session Session.persists',
  '@marmeon/session Session.readOnly',
  '@marmeon/session Session.regenerateToken',
  '@marmeon/session Session.started',
  '@marmeon/storage TemporaryUpload.extension',
  'marmeon Output.constructor',
];
