import { AssertionError } from 'node:assert';
import type { Container } from '@marmeon/core';
import type { AnyEntry, Entry, EntryContents, EntryType } from './entry.ts';
import { Recorder } from './recorder.ts';
import { MemoryStore } from './store.ts';

/**
 * What a test reads of the devtools — `app.devtools` of `createTestApp(App, { devtools: true })`:
 *
 * ```ts
 * await app.post('/register', { form: { … } });
 * app.devtools.assertRecorded('query', (query) => query.sql.includes('insert into "users"'));
 * app.devtools.entries('request')[0]!.content.route;   // 'auth.register'
 * ```
 *
 * The entries are those written so far — a request's when the test has its response (`createTestApp` waits for them).
 */
export class DevtoolsTester {
  readonly #container: Container;
  readonly #store: MemoryStore;

  constructor(container: Container, store: MemoryStore) {
    this.#container = container;
    this.#store = store;
  }

  /** The store the recorder writes to. */
  get store(): MemoryStore {
    return this.#store;
  }

  /** The entries recorded so far — of one type, if given — oldest first. */
  entries<T extends EntryType>(type: T): Entry<T>[];
  entries(): AnyEntry[];
  entries(type?: EntryType): AnyEntry[] {
    return this.#store.all().filter((entry) => type === undefined || entry.type === type);
  }

  /** The entries of one batch (a request with what it resolved in-process, a job attempt, a run, a command). */
  batch(id: string): AnyEntry[] {
    return this.#store.all().filter((entry) => entry.batch === id);
  }

  /** The first entry of `type` whose content passes `predicate` — or an assertion error listing what was recorded. */
  assertRecorded<T extends EntryType>(type: T, predicate: (content: EntryContents[T], entry: Entry<T>) => boolean = () => true): Entry<T> {
    const found = this.entries(type).find((entry) => predicate(entry.content, entry));
    if (found) return found;
    const recorded = this.entries(type);
    throw new AssertionError({
      message: `Expected the devtools to have recorded a ${type}${predicate.length > 0 ? ' matching the predicate' : ''}. Recorded ${recorded.length} ${type} ${recorded.length === 1 ? 'entry' : 'entries'}${recorded.length > 0 ? `:\n${recorded.slice(0, 10).map((entry) => `  ${JSON.stringify(entry.content).slice(0, 200)}`).join('\n')}` : '.'}`,
    });
  }

  /** No entry of `type` passes `predicate`. */
  assertNotRecorded<T extends EntryType>(type: T, predicate: (content: EntryContents[T], entry: Entry<T>) => boolean = () => true): this {
    const found = this.entries(type).find((entry) => predicate(entry.content, entry));
    if (found) throw new AssertionError({ message: `Expected the devtools not to have recorded this ${type}: ${JSON.stringify(found.content).slice(0, 300)}` });
    return this;
  }

  /** Waits until everything recorded so far is written (entries outside a request, after a job ran, …). */
  async settled(): Promise<void> {
    if (this.#container.has(Recorder)) await this.#container.make(Recorder).settled();
  }

  /** Forgets every entry. */
  clear(): Promise<void> {
    return this.#store.clear();
  }
}
