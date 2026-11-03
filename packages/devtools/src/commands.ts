import { relative } from 'node:path';
import { Application, escapeControls, Redactor } from '@marmeon/core';
import { CommandArgumentsError, type CommandInput } from 'marmeon';
import { DevtoolsConfig, loadDevtoolsOptions, resolveOptions } from './config.ts';
import { FileDevtoolsStore } from './file-store.ts';
import { ENTRY_TYPES, newestFirst, type AnyEntry, type EntryType } from './entry.ts';
import { DevtoolsStore, MemoryDevtoolsStore } from './store.ts';

/**
 * The app's store — the recorder's, or (devtools off in this process) its files: where `config/devtools.ts` puts them in
 * development (`DEVTOOLS_ENABLED=false`), the default directory anywhere else — the app's devtools settings are loaded in
 * development only.
 */
async function storeOf(app: Application): Promise<DevtoolsStore> {
  if (app.container.has(DevtoolsStore)) return app.container.make(DevtoolsStore);
  const development = app.container.make(DevtoolsConfig).environment === 'development';
  const { storage } = resolveOptions(development ? await loadDevtoolsOptions(app.root) : {}, app.root);
  return new FileDevtoolsStore({ directory: storage.path, maxBytes: storage.maxBytes, maxAgeHours: storage.maxAgeHours });
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `marmeon devtools:clear`: removes every recorded entry (`storage/framework/devtools/`). */
export class DevtoolsClearCommand {
  static command = 'devtools:clear';
  static description = 'Remove every entry the devtools recorded';

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const store = await storeOf(this.#app);
    const { bytes, files } = await store.usage();
    await store.clear();
    output.success(`Removed the devtools' entries (${files} ${files === 1 ? 'file' : 'files'}, ${megabytes(bytes)}).`);
    return 0;
  }
}

/** `marmeon devtools:prune`: removes entries past the ring's age, then the oldest until it is within its size. */
export class DevtoolsPruneCommand {
  static command = 'devtools:prune';
  static description = "Remove the devtools' entries past their age or size limit";

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const store = await storeOf(this.#app);
    const { files, bytes } = await store.prune();
    const usage = await store.usage();
    output.success(`Pruned ${files} ${files === 1 ? 'file' : 'files'} (${megabytes(bytes)}); ${usage.files} left (${megabytes(usage.bytes)}).`);
    return 0;
  }
}

/** What one entry of `devtools:list` may take (bytes of JSON), whatever it recorded. */
const ENTRY_BYTES = 16 * 1024;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** The types in `--type=a,b`: each one of {@link ENTRY_TYPES}. */
function typesOf(value: string | undefined): EntryType[] | undefined {
  if (value === undefined) return undefined;
  const types = value.split(',').map((type) => type.trim());
  const unknown = types.filter((type) => !(ENTRY_TYPES as readonly string[]).includes(type));
  if (unknown.length > 0 || types.length === 0) {
    throw new CommandArgumentsError(`--type takes a comma-separated list of: ${ENTRY_TYPES.join(', ')}.`);
  }
  return types as EntryType[];
}

function limitOf(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  const limit = /^\d{1,4}$/.test(value) ? Number(value) : 0;
  if (limit < 1 || limit > MAX_LIST_LIMIT) throw new CommandArgumentsError(`--limit takes a whole number from 1 to ${MAX_LIST_LIMIT}.`);
  return limit;
}

function stringOption(options: CommandInput['options'], name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

/** The shape of an identifier (the kernel's request ids are the widest): anything else is not one, and shows as `null`. */
const IDENTIFIER = /^[\w.:-]{1,128}$/;

/** An id is a key, not data: kept as it is — masking it with the app's patterns would break `--before` and `--request` — or `null`. */
function identifierOf(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : null;
}

const MAX_TAGS = 50;
const MAX_TAG_CHARS = 200;
/** How many entries one call reads from the store, however few match `--tag` or `--search`. */
const MAX_SCANNED = 2000;
const PAGE = 200;

function plain(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The entry as `devtools:list` shows it, or `undefined` for a line that is no entry (the store is files that any tool may
 * have written to): redacted once more with the app's redactor — by name and by shape — and cut to {@link ENTRY_BYTES}. The
 * identifiers are strings or `null`; a mail shows its `html` only without a `text`.
 */
function shown(raw: unknown, redactor: Redactor): AnyEntry | undefined {
  const entry = plain(raw);
  const type = entry.type;
  if (typeof type !== 'string' || !(ENTRY_TYPES as readonly string[]).includes(type) || typeof entry.at !== 'number' || Number.isNaN(new Date(entry.at).getTime())) return undefined;
  let content = plain(entry.content);
  if (type === 'mail') {
    const { html, ...rest } = content;
    content = content.text === undefined && html !== undefined ? content : rest;
  }
  const safe = plain(redactor.value(content));
  // The recorder replaces a statement's parameters on secret columns; a store written past it may not have.
  if (type === 'query' && content.sensitive === true && Array.isArray(safe.parameters)) safe.parameters = safe.parameters.map(() => '[redacted]');
  const tags = (Array.isArray(entry.tags) ? entry.tags : [])
    .filter((tag): tag is string => typeof tag === 'string')
    .slice(0, MAX_TAGS)
    .map((tag) => redactor.text(tag.slice(0, MAX_TAG_CHARS)));
  return {
    id: identifierOf(entry.id),
    type,
    at: entry.at,
    batch: identifierOf(entry.batch),
    requestId: identifierOf(entry.requestId),
    jobId: identifierOf(entry.jobId),
    tags,
    content: redactor.fit(safe, ENTRY_BYTES),
  } as unknown as AnyEntry;
}

/** One line for the table: what the entry is about, in at most 100 characters. */
function summaryOf(entry: AnyEntry): string {
  const content = entry.content as unknown as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  let line: string;
  switch (entry.type) {
    case 'request':
      line = [text(content.method), text(content.path), text(content.status)].join(' ');
      break;
    case 'query':
      line = text(content.sql);
      break;
    case 'job':
      line = `${text(content.status)} ${text(content.name)}`;
      break;
    case 'mail':
      line = `${text(content.mailable)} ${text(content.subject)}`;
      break;
    case 'notification':
      line = text(content.notification);
      break;
    case 'log':
      line = `${text(content.level)} ${text(content.message)}`;
      break;
    case 'exception':
      line = `${text(content.class)}: ${text(content.message)}`;
      break;
    case 'schedule':
      line = `${text(content.task)} ${text(content.outcome)}`;
      break;
    case 'live':
      line = text(content.channel);
      break;
    case 'event':
      line = text(content.name);
      break;
    case 'command':
      line = `${text(content.command)} ${text(content.exitCode)}`;
      break;
  }
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}

/**
 * `marmeon devtools:list`: the recorded entries, newest first, as a table or (`--json`) as a document. Entries are
 * redacted once more on the way out and cut to 16 KiB each; a call returns at most 100. See docs/devtools.md#where-the-entries-live.
 */
export class DevtoolsListCommand {
  static command = 'devtools:list';
  static description = "List the devtools' entries, newest first";
  static usage = '[--type=<types>] [--tag=<tag>] [--request=<id>] [--search=<text>] [--before=<id>] [--limit=<n>] [--json]';
  static options = {
    type: { type: 'string' },
    tag: { type: 'string' },
    request: { type: 'string' },
    search: { type: 'string' },
    before: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
  } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle({ options, output }: CommandInput): Promise<void> {
    const type = typesOf(stringOption(options, 'type'));
    const limit = limitOf(stringOption(options, 'limit'));
    const tag = stringOption(options, 'tag');
    const requestId = stringOption(options, 'request');
    const search = stringOption(options, 'search');
    const before = stringOption(options, 'before');

    const store = await storeOf(this.#app);
    const container = this.#app.container;
    const redactor = container.has(Redactor) ? container.make(Redactor) : new Redactor();
    // --tag and --search match what is shown, not what is stored: a masked value cannot be found out by searching for it.
    // The store pages without them, and the pages are read until `limit` entries match or the store ends.
    const term = search === undefined || search === '' ? undefined : search.toLowerCase();
    const start = before === undefined ? undefined : await store.get(before);
    if (before !== undefined && !start) {
      throw new CommandArgumentsError('--before names no entry in the store (it was pruned, or it is past the age limit). Leave it out to start with the newest.');
    }
    const filters = { ...(type ? { type } : {}), ...(requestId === undefined ? {} : { requestId }) };
    const entries: AnyEntry[] = [];
    const sources: unknown[] = [];
    const warnings: string[] = [];
    let scanned = 0;
    let cursor = before;
    let last: AnyEntry | undefined = start;
    let capped = false;
    // A page must lie behind the cursor: a store restarts at the newest entry when the cursor was pruned meanwhile.
    const behind = (entry: AnyEntry | undefined) => last === undefined || entry === undefined || newestFirst(entry, last) > 0;
    reading: while (true) {
      if (scanned >= MAX_SCANNED) {
        // The store may end exactly here: only an entry beyond the window says the cap stopped the scan.
        const ahead = await store.list({ ...filters, ...(cursor === undefined ? {} : { before: cursor }), limit: 1 });
        capped = ahead.length > 0 && behind(ahead[0]);
        break;
      }
      const page = await store.list({ ...filters, ...(cursor === undefined ? {} : { before: cursor }), limit: PAGE });
      if (!behind(page[0])) {
        warnings.push('An entry was pruned while the list was read; run the command again.');
        break;
      }
      for (const raw of page) {
        scanned++;
        last = raw;
        const entry = shown(raw, redactor);
        if (!entry) continue;
        if (tag !== undefined && !entry.tags.includes(tag)) continue;
        if (term !== undefined && !JSON.stringify(entry).toLowerCase().includes(term)) continue;
        entries.push(entry);
        sources.push(raw);
        if (entries.length > limit) break reading;
      }
      if (page.length < PAGE) break;
      cursor = last!.id;
    }
    const more = entries.length > limit;
    if (more) entries.length = limit;
    const truncated = more || capped;
    // Where to continue: after the last entry shown when `limit` stopped the list, after the last one read when the cap did.
    const next = capped ? identifierOf(last?.id) : more ? identifierOf((sources[limit - 1] as AnyEntry).id) : null;
    if (capped) warnings.push(`Stopped after reading ${MAX_SCANNED} entries; narrow the list with --type or --request, or continue with --before=<next>.`);
    const memory = store instanceof MemoryDevtoolsStore;
    if (memory) warnings.push('The entries are in the memory of the process that recorded them; another process, such as this command, does not see them.');

    if (options.json === true) {
      output.json({
        format: 1,
        store: { driver: memory ? 'memory' : 'file', path: store instanceof FileDevtoolsStore ? displayPath(this.#app.root, store.directory) : null },
        entries,
        truncated,
        next,
        warnings,
      });
      return;
    }
    output.table(
      ['TIME', 'TYPE', 'TAGS', 'SUMMARY'],
      entries.map((entry) => [new Date(entry.at).toISOString(), entry.type, entry.tags.join(','), summaryOf(entry)].map(escapeControls)),
    );
    output.line();
    output.line(`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${truncated && next !== null ? escapeControls(` (more: --before=${next})`) : ''}`);
    for (const warning of warnings) output.line(escapeControls(warning));
  }
}

/** The directory relative to the app, where it lies inside; else as it is. */
function displayPath(root: string, directory: string): string {
  const path = relative(root, directory);
  return path === '' || path.startsWith('..') ? directory : path;
}
