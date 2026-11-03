import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application, EventRegistry, type EventClass, type ListenerBinding, type ModuleDefinition } from '@marmeon/core';
import { isQueuedListener } from '@marmeon/core/internal';
import type { CommandInput } from '../command.ts';

/** The longest string taken from app code into the document. */
const MAX_LENGTH = 200;

/** A string from app code, cut to {@link MAX_LENGTH}; anything that is not a string is `null`. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_LENGTH) : null;
}

/** The name of a class or function. */
function nameOf(value: unknown): string {
  return text((value as { name?: unknown } | null | undefined)?.name) || '(anonymous)';
}

/** The class-like items of the list a module keeps under `key`. Only a list is read, nothing else of the module. */
function listOf(module: ModuleDefinition, key: string): readonly unknown[] {
  const value = (module as unknown as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

/** The `static <key>` of each class in `classes`: `{ class, <key> }`. */
function named<K extends string>(classes: readonly unknown[], key: K): ({ class: string } & Record<K, string | null>)[] {
  return classes.map((item) => ({ class: nameOf(item), [key]: text((item as Record<string, unknown> | null)?.[key]) }) as { class: string } & Record<K, string | null>);
}

interface ListenerEntry {
  readonly listener: string;
  readonly queued: boolean;
  readonly defined: 'app' | 'module' | 'provider';
  readonly module: string | null;
}

interface EventEntry {
  readonly event: string;
  readonly name: string | null;
  readonly listeners: ListenerEntry[];
}

/**
 * Lists what the app defines: the packages, the modules with their providers, commands, jobs, notifications and seeders,
 * and the listeners of each event. Registers the providers and boots none, and reads only the fields it prints — never
 * configuration or `.env`. With `--json` it prints format 1. See docs/modules.md#listing-the-modules.
 */
export class ModulesListCommand {
  static command = 'modules:list';
  static description = 'List the modules with their providers, commands, jobs and the listeners of each event';
  static usage = '[--json]';
  static options = { json: { type: 'boolean' } } as const;
  /** Registers the providers and boots nothing, like `route:types`: no secrets, no connection, no `boot()` of the app runs. */
  static boots = 'build' as const;

  readonly #app: Application;
  readonly #events: EventRegistry;

  constructor(app: Application, events: EventRegistry) {
    this.#app = app;
    this.#events = events;
  }

  handle({ options, output, root }: CommandInput): void {
    const packages = this.#app.packages.map((name) => text(name) ?? '');
    const app = { providers: (this.#app.definition.providers ?? []).map(nameOf) };
    const warnings: string[] = [];
    const modules = this.#app.modules.map((module) => {
      const migrations = migrationsFolder(root, (module as { migrations?: unknown }).migrations);
      if (migrations.problem !== undefined) warnings.push(`${text(module.name) ?? ''}: ${migrations.problem}`);
      return {
      name: text(module.name) ?? '',
      providers: (module.providers ?? []).map(nameOf),
      commands: listOf(module, 'commands')
        .map((command) => text((command as { command?: unknown } | null)?.command))
        .filter((name): name is string => name !== null),
      jobs: named(listOf(module, 'jobs'), 'job'),
      notifications: named(listOf(module, 'notifications'), 'notification'),
      seeders: listOf(module, 'seeders').map(nameOf),
      migrations: migrations.folder,
      };
    });
    const events = this.#eventList();

    if (options.json === true) {
      output.json({ format: 1, packages, app, modules, events, warnings });
      return;
    }
    for (const warning of warnings) output.warn(warning);
    if (modules.length === 0) {
      output.line('The app has no modules. Create one with `marmeon make:module <name>`.');
    }
    for (const module of modules) {
      output.line(module.name);
      const rows: [string, string[]][] = [
        ['providers', module.providers],
        ['commands', module.commands],
        ['jobs', module.jobs.map((job) => (job.job === null ? job.class : `${job.class} (${job.job})`))],
        ['notifications', module.notifications.map((item) => (item.notification === null ? item.class : `${item.class} (${item.notification})`))],
        ['seeders', module.seeders],
        ['migrations', module.migrations === null ? [] : [module.migrations]],
      ];
      for (const [label, values] of rows) if (values.length > 0) output.line(`  ${label}: ${values.join(', ')}`);
    }
    if (events.length > 0) {
      output.line();
      output.line('Events');
      for (const entry of events) {
        for (const listener of entry.listeners) {
          output.line(`  ${entry.event} → ${listener.listener}${listener.queued ? ' (queued)' : ''}`);
        }
      }
    }
  }

  /** Every event with its listeners, sorted by the event's class name; the listeners keep their registration order. */
  #eventList(): EventEntry[] {
    const origins = this.#origins();
    const byEvent = new Map<EventClass, EventEntry>();
    for (const { event, listener } of this.#events.all()) {
      let entry = byEvent.get(event);
      if (entry === undefined) {
        entry = { event: nameOf(event), name: text((event as { event?: unknown }).event), listeners: [] };
        byEvent.set(event, entry);
      }
      const origin = origins.get(event)?.get(listener) ?? { defined: 'provider' as const, module: null };
      entry.listeners.push({ listener: nameOf(listener), queued: isQueuedListener(listener), ...origin });
    }
    return [...byEvent.values()].sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
  }

  /** Where each (event, listener) pair was declared; the first declaration wins. What the definitions do not name came from a provider. */
  #origins(): Map<EventClass, Map<ListenerBinding['listener'], Pick<ListenerEntry, 'defined' | 'module'>>> {
    const origins = new Map<EventClass, Map<ListenerBinding['listener'], Pick<ListenerEntry, 'defined' | 'module'>>>();
    const note = (bindings: readonly ListenerBinding[] | undefined, defined: 'app' | 'module', module: string | null): void => {
      for (const { event, listener } of bindings ?? []) {
        const listeners = origins.get(event) ?? new Map();
        if (!listeners.has(listener)) listeners.set(listener, { defined, module });
        origins.set(event, listeners);
      }
    };
    note(this.#app.definition.listeners, 'app', null);
    for (const module of this.#app.modules) note(module.listeners, 'module', text(module.name) ?? '');
    return origins;
  }
}

/**
 * The migrations folder relative to the app root, `/`-separated. `folder` is `null` when the module has none, or when it lies
 * elsewhere: `problem` then says why, so that "none" and "elsewhere" can be told apart.
 */
function migrationsFolder(root: string, value: unknown): { folder: string | null; problem?: string } {
  let path: string;
  try {
    if (value instanceof URL) path = fileURLToPath(value);
    else if (typeof value === 'string' && value !== '') path = resolve(root, value);
    else return { folder: null };
  } catch {
    return { folder: null, problem: 'its migrations folder is not a path on this machine' };
  }
  const folder = relative(root, path);
  if (folder === '' || folder === '..' || folder.startsWith(`..${sep}`) || isAbsolute(folder)) {
    return { folder: null, problem: 'its migrations folder lies outside the app root' };
  }
  return { folder: folder.split(sep).join('/') };
}
