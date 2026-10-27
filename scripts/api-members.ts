/**
 * The exceptions to "a class member of a stable entry point is used by an app, the docs or the kit" that `pnpm api:check` enforces
 * (`scripts/api.ts`; CONTRIBUTING.md, "The API snapshot"). A key is `<entry> <Class>.<member>` (`<entry> <Class>.constructor` for the
 * constructor); `<entry> <Class>.*` stands for every member of a class and `<entry> *` for every class of an entry.
 */

/** Members that stay public although no app code calls them. Each says why; nothing else belongs here. */
export const MEMBER_EXCEPTIONS: Readonly<Record<string, string>> = {
  '@marmeon/http/client/adapter *': 'the contract of a client adapter: an adapter for another UI library calls it',
  '@marmeon/i18n Catalog.translate': 'the hook of a UI adapter returns it: an adapter for another UI library calls it',
  '@marmeon/i18n Catalog.formatter': 'the hook of a UI adapter hands it on with the translation: an adapter for another UI library calls it',
  '@marmeon/live/testing LiveStreamReader.heartbeats': 'a test of the stream itself reads it; documented with the test reader',
  '@marmeon/live/testing LiveStreamReader.retryMs': 'a test of the stream itself reads it; documented with the test reader',
  '@marmeon/table RowAction.handler': 'defineTable infers the handler class from it and checks its handle(row, ctx) against the table\'s row',
  '@marmeon/table BulkAction.handler': 'defineTable infers the handler class from it and checks its handle(rows, ctx) against the table\'s row',
  '@marmeon/table/client TableController.*': 'the React adapter builds the controller and an adapter for another UI library does the same',
};
