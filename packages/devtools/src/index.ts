// @marmeon/devtools (E115–E118, E124, E125): the recorder and its store — what a request, job, scheduled run or command
// did, kept as redacted entries in `storage/framework/devtools/` (development only). The pages under `/_marmeon/devtools`
// read them through the store (W7 step 8).
export { DevtoolsClearCommand, DevtoolsPruneCommand } from './commands.ts';
export {
  DEFAULT_IGNORED_COMMANDS,
  DEFAULT_IGNORED_PATHS,
  defineDevtools,
  DevtoolsConfig,
  DevtoolsConfigError,
  ignoresPath,
  loadDevtoolsOptions,
  resolveOptions,
  WATCHERS,
} from './config.ts';
export type { DevtoolsDefinition, DevtoolsOptions, PathPattern, ResolvedDevtoolsOptions, Watcher } from './config.ts';
export { ENTRY_TYPES, EntryIds, newestFirst } from './entry.ts';
export type {
  AnyEntry,
  CommandContent,
  Entry,
  EntryContents,
  EntryType,
  ErrorContent,
  EventContent,
  ExceptionContent,
  JobContent,
  LiveContent,
  LogContent,
  MailContent,
  NotificationContent,
  QueryContent,
  RequestContent,
  ScheduleContent,
} from './entry.ts';
export { DEFAULT_MAX_AGE_HOURS, DEFAULT_MAX_BYTES, FileStore } from './file-store.ts';
export type { FileStoreOptions } from './file-store.ts';
export { BAR_SCRIPT, barMarkup, DevtoolsServiceProvider, DevtoolsSettings } from './provider.ts';
export { API_VERSION, BASE, MAIL_CSP, PAGE_CSP, registerDevtoolsPages } from './pages/index.ts';
export type { PagesOptions } from './pages/index.ts';
export type { FailedJobView, QueueSnapshot, QueueView, ScheduleSnapshot, TaskView } from './pages/infra.ts';
export { MAX_BATCH_ENTRIES, Recorder } from './recorder.ts';
export type { RecorderOptions } from './recorder.ts';
export { DEFAULT_LIMIT, DevtoolsStore, matchesEntry, MAX_LIMIT, MemoryStore } from './store.ts';
export type { EntryQuery, EntryTail, PruneResult, StoreUsage } from './store.ts';
export { DevtoolsTester, DevtoolsTestOptIn, enableDevtoolsForTests } from './testing.ts';
