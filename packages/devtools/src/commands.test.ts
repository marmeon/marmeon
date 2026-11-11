import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication } from '@marmeon/core';
import { CommandArgumentsError } from 'marmeon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevtoolsClearCommand, DevtoolsListCommand, DevtoolsPruneCommand } from './commands.ts';
import type { AnyEntry, EntryContents, EntryType } from './entry.ts';
import { FileDevtoolsStore } from './file-store.ts';
import { DevtoolsStore } from './store.ts';
import { DevtoolsServiceProvider } from './provider.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

/** An app whose config/devtools.ts throws when it is loaded — and its default storage directory. */
function root(): string {
  const dir = tempDir('marmeon-devtools-commands-');
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config/devtools.ts'), "throw new Error('config/devtools.ts was loaded');\n");
  return dir;
}

const output = () => {
  const lines: string[] = [];
  return { lines, output: { success: (line: string) => lines.push(line), line: (line = '') => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) } };
};

describe('devtools:clear and devtools:prune', () => {
  it('never load config/devtools.ts outside development — they clear the default directory', async () => {
    for (const NODE_ENV of ['production', 'test']) {
      const dir = root();
      const app = await createApplication({ root: dir, discover: false, providers: [DevtoolsServiceProvider] }, { env: { NODE_ENV } });
      try {
        for (const Command of [DevtoolsClearCommand, DevtoolsPruneCommand]) {
          const { lines, output: out } = output();
          const code = await new Command(app).handle({ output: out } as never).catch((error: Error) => `threw: ${error.message}`);
          expect(code, `${NODE_ENV} ${Command.command}: ${String(code)} ${lines.join(' ')}`).toBe(0);
        }
      } finally {
        await app.shutdown();
      }
    }
  });
});

const TOKEN = 'Qm9yZ2VkVG9rZW5Gb3JUZXN0c0Fub3RoZXJPbmVIZXJl';
const formats = new URL('./__fixtures__/formats/cli-devtools-list/', import.meta.url);

function entry<T extends EntryType>(id: string, type: T, at: number, content: EntryContents[T], extra: { tags?: string[]; requestId?: string } = {}): AnyEntry {
  return { id, type, at, batch: `batch-${id}`, tags: extra.tags ?? [], ...(extra.requestId ? { requestId: extra.requestId } : {}), content } as AnyEntry;
}

/** A fake console that keeps what a command prints. */
function console() {
  const lines: string[] = [];
  const documents: unknown[] = [];
  const out = {
    json: (document: unknown) => documents.push(document),
    table: (header: readonly string[], rows: readonly (readonly string[])[]) => lines.push(header.join('  '), ...rows.map((row) => row.join('  '))),
    line: (line = '') => lines.push(line),
  };
  return { lines, documents, out };
}

async function listApp(entries: readonly AnyEntry[], env: Record<string, string> = { NODE_ENV: 'test' }, definition: { redact?: { keys?: string[]; patterns?: RegExp[] } } = {}) {
  // The store keeps what is younger than its age limit: the clock stands just after the entries' times.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(10_000));
  const dir = root();
  const app = await createApplication({ root: dir, discover: false, providers: [DevtoolsServiceProvider], ...definition }, { env });
  await new FileDevtoolsStore({ directory: join(dir, 'storage/framework/devtools') }).write(entries);
  const list = async (options: Record<string, string | boolean> = {}) => {
    const { lines, documents, out } = console();
    await new DevtoolsListCommand(app).handle({ args: [], options, output: out, root: dir } as never);
    return { lines, document: documents[0] as { format: number; store: unknown; entries: AnyEntry[]; truncated: boolean; next: string | null; warnings: string[] } | undefined };
  };
  return { app, list };
}

const mixed = [
  entry('000000001aa0000000001', 'request', 1_000, {
    method: 'GET', url: '/users/1', path: '/users/1', route: 'users.show', status: 200, durationMs: 4, inProcess: false, headers: { accept: 'text/html' }, query: {},
  }, { tags: ['status:200', 'route:users.show'], requestId: 'req-1' }),
  entry('000000002aa0000000002', 'query', 2_000, { connection: 'default', driver: 'sqlite', sql: 'select  *\nfrom users', parameters: [], sensitive: false, durationMs: 1, slow: false }, { requestId: 'req-1' }),
  entry('000000003aa0000000003', 'mail', 3_000, {
    mailable: 'Welcome', mode: 'send', to: ['a@example.com'], cc: [], bcc: [], subject: 'Hi', html: '<p>Hello</p>', text: 'Hello', attachments: [],
  }, { tags: ['Welcome'] }),
  entry('000000004aa0000000004', 'job', 4_000, { status: 'done', name: 'reports.build', queue: 'default', connection: 'sync', attempt: 1 }, { tags: ['reports.build'] }),
];

describe('devtools:list', () => {
  afterEach(() => vi.useRealTimers());

  it('prints the document of the format fixture — newest first, a mail with its text only, every key present', async () => {
    const { app, list } = await listApp(mixed);
    try {
      const { document } = await list({ json: true });
      const fixture = JSON.parse(readFileSync(new URL('v1.json', formats), 'utf8')) as { entries: object[] };
      expect(readdirSync(formats).sort()).toEqual(['v1-browser.json', 'v1.json']);
      expect(document).toMatchObject(fixture);
      // toMatchObject ignores extra keys: the document and each entry have exactly these, in this order.
      expect(Object.keys(document!)).toEqual(['format', 'store', 'entries', 'truncated', 'next', 'warnings']);
      expect(Object.keys(document!.store as object)).toEqual(['driver', 'path']);
      expect(document!.entries.map((e) => Object.keys(e))).toEqual(Array(4).fill(['id', 'type', 'at', 'batch', 'requestId', 'jobId', 'tags', 'content']));
      expect(document!.entries.map((e) => [e.requestId, e.jobId])).toEqual([[null, null], [null, null], ['req-1', null], ['req-1', null]]);
    } finally {
      await app.shutdown();
    }
  });

  it('filters by type, tag and request, and says when the limit left entries out', async () => {
    const { app, list } = await listApp(mixed);
    try {
      expect((await list({ json: true, type: 'query,job' })).document!.entries.map((e) => e.type)).toEqual(['job', 'query']);
      expect((await list({ json: true, tag: 'Welcome' })).document!.entries.map((e) => e.type)).toEqual(['mail']);
      expect((await list({ json: true, request: 'req-1' })).document!.entries.map((e) => e.type)).toEqual(['query', 'request']);
      expect((await list({ json: true, search: 'reports' })).document!.entries.map((e) => e.type)).toEqual(['job']);
      const page = (await list({ json: true, limit: '3' })).document!;
      expect(page.entries).toHaveLength(3);
      expect(page.truncated).toBe(true);
      expect(page.next).toBe(page.entries[2]!.id);
      const rest = (await list({ json: true, before: page.entries[2]!.id })).document!;
      expect(rest.entries.map((e) => e.type)).toEqual(['request']);
      expect(rest.truncated).toBe(false);
      expect(rest.next).toBeNull();
    } finally {
      await app.shutdown();
    }
  });

  it('prints a table with one line per entry', async () => {
    const { app, list } = await listApp(mixed);
    try {
      const { lines } = await list();
      expect(lines[0]).toBe('TIME  TYPE  TAGS  SUMMARY');
      expect(lines[1]).toContain('job  reports.build  done reports.build');
      expect(lines[2]).toContain('Welcome  Welcome Hi');
      expect(lines[3]).toContain('select * from users');
      expect(lines.at(-1)).toBe('4 entries');
    } finally {
      await app.shutdown();
    }
  });

  it('lists browser entries — the format fixture, filtered by type and found by its text', async () => {
    const fixture = JSON.parse(readFileSync(new URL('v1-browser.json', formats), 'utf8')) as { entries: AnyEntry[] };
    const { app, list } = await listApp([...mixed, ...fixture.entries]);
    try {
      const { document } = await list({ json: true, type: 'browser' });
      expect(document).toMatchObject({ format: 1, entries: fixture.entries, truncated: false, next: null, warnings: [] });
      expect(Object.keys(document!.entries[0]!.content)).toEqual(['kind', 'level', 'message', 'stack', 'source', 'page', 'dropped']);
      expect((await list({ json: true, search: 'x is undefined' })).document!.entries.map((e) => e.type)).toEqual(['browser']);
      expect((await list({ json: true, tag: 'level:error' })).document!.entries.map((e) => e.type)).toEqual(['browser']);
      expect((await list({ json: true, type: 'browser,job' })).document!.entries.map((e) => e.type)).toEqual(['browser', 'job']);
      expect((await list({ type: 'browser' })).lines[1]).toContain('browser  level:error,kind:error  error Uncaught TypeError: x is undefined');
    } finally {
      await app.shutdown();
    }
  });

  it('shows a browser report in the terminal without a control character — even one a producer left in', async () => {
    const hostile = '\u001b[2J\u001b[1;1Hpwned\rfake line\u009b31m\u202eevil\u0007';
    const raw = entry('000000005aa0000000005', 'browser', 5_000, { kind: 'console', level: 'error', message: `boom ${hostile}`, page: `/p${hostile}` }, { tags: [`kind:${hostile}`] });
    const { app, list } = await listApp([raw]);
    try {
      const { lines } = await list({ type: 'browser' });
      const text = lines.join('\n');
      expect(text).toContain('boom \\u001b[2J');
      // eslint-disable-next-line no-control-regex -- the point of the test
      expect(lines.every((line) => !/[\u001b\u009b\u0007\r\u202e]/.test(line))).toBe(true);
    } finally {
      await app.shutdown();
    }
  });

  it('rejects an unknown type and a limit out of range with the accepted values', async () => {
    const { app, list } = await listApp([]);
    try {
      await expect(list({ type: 'requests' })).rejects.toThrow(/--type takes .*request, query, job, mail/);
      await expect(list({ type: 'request;rm' })).rejects.toBeInstanceOf(CommandArgumentsError);
      for (const limit of ['0', '101', '-1', 'ten', '1e2', '']) {
        await expect(list({ limit }), `limit ${limit}`).rejects.toThrow(/--limit takes a whole number from 1 to 100/);
      }
    } finally {
      await app.shutdown();
    }
  });

  it('masks again what a store holds unmasked — written past the recorder', async () => {
    const raw = [
      entry('000000005aa0000000005', 'request', 5_000, {
        method: 'GET',
        url: `/invite/${TOKEN}?token=${TOKEN}`,
        path: '/callback',
        inProcess: false,
        headers: { authorization: `Bearer ${TOKEN}`, cookie: `marmeon_session=${TOKEN}`, accept: 'text/html' },
        query: { token: TOKEN },
        input: { password: 'hunter2', name: 'Ada' },
      }, { tags: [`invite:${TOKEN}`] }),
      entry('000000006aa0000000006', 'mail', 6_000, {
        mailable: 'Reset', mode: 'send', to: ['a@example.com'], cc: [], bcc: [], subject: 'Reset',
        text: `Open https://example.com/reset-password/${TOKEN} now`, attachments: [],
      }),
      entry('000000007aa0000000007', 'event', 7_000, { name: 'users.signed-in', class: 'SignedIn', payload: { password: 'hunter2', iban: 'DE89370400440532013000', user: 'ada' }, listeners: [] }),
      entry('000000008aa0000000008', 'query', 8_000, { connection: 'default', driver: 'sqlite', sql: 'select 1', parameters: ['hunter2', 3], sensitive: true, durationMs: 1, slow: false }),
      entry('000000009aa0000000009', 'query', 9_000, { connection: 'default', driver: 'sqlite', sql: 'select 2', parameters: ['kept-parameter'], sensitive: false, durationMs: 1, slow: false }),
    ];
    const { app, list } = await listApp(raw, { NODE_ENV: 'test' }, { redact: { keys: ['iban'] } });
    try {
      const { document } = await list({ json: true });
      const json = JSON.stringify(document);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain('hunter2');
      expect(json).not.toContain('DE89370400440532013000');
      expect(json).toContain('ada');
      expect(json).toContain('kept-parameter');
      expect(JSON.stringify(document!.entries.find((e) => e.type === 'mail')!.content)).toContain('/reset-password/');
    } finally {
      await app.shutdown();
    }
  });

  it('matches --search and --tag against what is shown — a masked value cannot be found by searching for it', async () => {
    const raw = [
      entry('000000005aa0000000005', 'event', 5_000, { name: 'a', class: 'A', payload: { password: 'hunter2' }, listeners: [] }, { tags: [`invite:${TOKEN}`] }),
      entry('000000006aa0000000006', 'log', 6_000, { level: 'info', message: 'needle', context: {} }),
      ...Array.from({ length: 250 }, (_, i) => entry(`0000001${String(i).padStart(2, '0')}aa00000000${i}`, 'log', 7_000 + i, { level: 'info', message: 'noise', context: {} })),
    ];
    const { app, list } = await listApp(raw);
    try {
      expect((await list({ json: true, search: 'hunter' })).document!.entries).toEqual([]);
      expect((await list({ json: true, tag: `invite:${TOKEN}` })).document!.entries).toEqual([]);
      // The needle lies behind more than one page of other entries.
      const found = (await list({ json: true, search: 'needle', limit: '2' })).document!;
      expect(found.entries.map((e) => e.content)).toMatchObject([{ message: 'needle' }]);
      expect(found.truncated).toBe(false);
      expect((await list({ json: true, search: 'noise', limit: '3' })).document!.truncated).toBe(true);
    } finally {
      await app.shutdown();
    }
  });

  describe('reading a long store', () => {
    const logs = (count: number, first = 2) =>
      Array.from({ length: count }, (_, i) => entry(String(i + first).padStart(9, '0'), 'log', i + first, { level: 'info', message: 'noise', context: {} }));

    it('stops at the cap and names where to continue — the next call finds what lies behind', async () => {
      const needle = entry('000000001', 'log', 1, { level: 'info', message: 'needle', context: {} });
      const { app, list } = await listApp([needle, ...logs(2300)]);
      try {
        const first = (await list({ json: true, search: 'needle' })).document!;
        expect(first.entries).toEqual([]);
        expect(first.truncated).toBe(true);
        expect(first.next).toBe(String(2301 - 1999).padStart(9, '0'));
        expect(first.warnings.join()).toMatch(/Stopped after reading 2000 entries/);
        const second = (await list({ json: true, search: 'needle', before: first.next! })).document!;
        expect(second.entries.map((e) => e.content)).toMatchObject([{ message: 'needle' }]);
        expect(second.truncated).toBe(false);
        expect(second.next).toBeNull();
        const text = (await list({ search: 'needle' })).lines.join('\n');
        expect(text).toContain(`--before=${first.next}`);
      } finally {
        await app.shutdown();
      }
    });

    it('is not truncated when the store ends exactly at the cap', async () => {
      const { app, list } = await listApp(logs(2000));
      try {
        const { document } = await list({ json: true, search: 'zzz' });
        expect(document).toMatchObject({ entries: [], truncated: false, next: null });
        expect(document!.warnings).toEqual([]);
      } finally {
        await app.shutdown();
      }
    });

    it('ends when a store restarts at the newest entry — a cursor pruned between pages, or between get and list', async () => {
      const page = logs(200);
      let calls = 0;
      const { app, list } = await listApp([]);
      app.container.instance(DevtoolsStore, { list: async () => { calls++; return [...page].reverse(); }, get: async () => page[0] } as unknown as DevtoolsStore);
      try {
        const { document } = await list({ json: true, search: 'zzz', before: page[0]!.id });
        expect(calls).toBe(1);
        expect(document).toMatchObject({ entries: [], truncated: false, next: null });
        expect(document!.warnings.join()).toMatch(/pruned while the list was read/);
      } finally {
        await app.shutdown();
      }
    });

    it('keeps ids as they are under an app pattern, and shows a hostile batch, request or job id as null', async () => {
      const six = entry('req-123456-abc', 'log', 5, { level: 'info', message: 'one', context: {} }, { requestId: '123456-7890-4abc' });
      const { app, list } = await listApp([six, ...logs(3, 6), entry('000000009', 'log', 9, { level: 'info', message: 'last', context: {} })], { NODE_ENV: 'test' }, { redact: { patterns: [/\d{6}/] } });
      try {
        const all = (await list({ json: true })).document!;
        expect(all.entries.map((e) => e.id)).toContain('req-123456-abc');
        const page = (await list({ json: true, limit: '2' })).document!;
        expect(page.next).toBe(page.entries[1]!.id);
        expect((await list({ json: true, before: page.next! })).document!.entries).not.toHaveLength(0);
        expect((await list({ json: true, request: '123456-7890-4abc' })).document!.entries.map((e) => e.requestId)).toEqual(['123456-7890-4abc']);
      } finally {
        await app.shutdown();
      }
      const hostile = await listApp([]);
      hostile.app.container.instance(DevtoolsStore, {
        list: async () => ['has space', 'new\nline', 'x'.repeat(129), '\u001b[31m'].map((bad, i) => ({ ...logs(1)[0]!, id: `ok${i}`, batch: bad, requestId: bad, jobId: bad })),
      } as unknown as DevtoolsStore);
      try {
        const { document } = await hostile.list({ json: true });
        expect(document!.entries.map((e) => [e.id, e.batch, e.requestId, e.jobId])).toEqual([0, 1, 2, 3].map((i) => [`ok${i}`, null, null, null]));
      } finally {
        await hostile.app.shutdown();
      }
    });

    it('leaves out an entry without a usable id, so `next` always works as --before', async () => {
      const bad = { ...logs(1)[0]!, id: 'has space', at: 50 };
      const { app, list } = await listApp([]);
      const good = logs(3, 10).reverse();
      app.container.instance(DevtoolsStore, { list: async () => [bad, ...good], get: async () => good[0] } as unknown as DevtoolsStore);
      try {
        const { document } = await list({ json: true, limit: '1' });
        expect(document!.entries.map((e) => e.id)).toEqual([good[0]!.id]);
        expect(document).toMatchObject({ truncated: true, next: good[0]!.id });
      } finally {
        await app.shutdown();
      }
    });

    it('names the last readable id as `next` when the cap stops at an entry without one', async () => {
      const { app, list } = await listApp([]);
      const all = logs(2001).reverse();
      const badLast = { ...all[1999]!, id: 'has space' };
      const window = [...all.slice(0, 1999), badLast];
      app.container.instance(DevtoolsStore, {
        list: async (query: { before?: string; limit?: number }) => {
          const from = query.before === undefined ? 0 : window.findIndex((e) => e.id === query.before) + 1;
          return from === 0 && query.before !== undefined ? all.slice(2000) : (query.before === undefined || from > 0 ? [...window, ...all.slice(2000)].slice(from, from + (query.limit ?? 50)) : []);
        },
      } as unknown as DevtoolsStore);
      try {
        const { document } = await list({ json: true, search: 'zzz' });
        expect(document).toMatchObject({ truncated: true, next: all[1998]!.id });
      } finally {
        await app.shutdown();
      }
    });

    it('refuses a --before that names no entry instead of listing the newest', async () => {
      const { app, list } = await listApp(logs(3));
      try {
        await expect(list({ json: true, before: 'pruned-long-ago' })).rejects.toThrow(/--before names no entry/);
        await expect(list({ json: true, before: 'pruned-long-ago' })).rejects.toBeInstanceOf(CommandArgumentsError);
      } finally {
        await app.shutdown();
      }
    });
  });

  it('shows no control character of recorded text on the terminal', async () => {
    const hostile = '\u001b]52;c;ZXZpbA==\u0007 \u202Eevil';
    const { app, list } = await listApp([
      entry('000000005aa0000000005', 'log', 5_000, { level: 'info', message: `x${hostile}`, context: {} }, { tags: [`t${hostile}`] }),
    ]);
    try {
      const { lines } = await list();
      const text = lines.join('\n');
      expect(text).toContain('\\u001b]52;c;ZXZpbA==\\u0007');
      expect(text).toContain('\\u202e');
      // eslint-disable-next-line no-control-regex -- the point of the test
      expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e]/);
    } finally {
      await app.shutdown();
    }
  });

  it('survives a store line that is not an entry — wrong types are skipped or null, never a throw', async () => {
    const odd = [
      { id: 7, type: 'log', at: 9_000, batch: { a: 1 }, requestId: 5, jobId: [], tags: 'not-a-list', content: { level: 'info', message: 'odd', context: {} } },
      { id: 'z', type: 'log', at: 9_050, batch: { a: 1 }, requestId: 5, jobId: [], tags: 'not-a-list', content: { level: 'info', message: 'odd', context: {} } },
      { id: 'x', type: 'bogus', at: 9_100, batch: 'b', tags: [], content: {} },
      // A time outside the Date range would make the table's toISOString() throw.
      { id: 'z', type: 'log', at: 1e20, batch: 'b', tags: [], content: { level: 'info', message: 'far', context: {} } },
      { id: 'y', type: 'log', at: 9_200, batch: 'b', tags: [1, null, 'ok', `k${TOKEN}`, ...Array.from({ length: 500 }, (_, i) => `many${i}`)], content: null },
    ] as unknown as AnyEntry[];
    const { app, list } = await listApp([]);
    // The file store drops such lines itself; the command does not rely on it (any store may be bound).
    app.container.instance(DevtoolsStore, { list: async () => odd } as unknown as DevtoolsStore);
    try {
      const { document } = await list({ json: true });
      // The entry without a usable id (`id: 7`) is left out.
      expect(document!.entries).toHaveLength(2);
      expect(document!.entries[1]).toMatchObject({ id: 'y', batch: 'b', requestId: null, jobId: null });
      expect(document!.entries[0]).toMatchObject({ id: 'z', batch: null, requestId: null, jobId: null, tags: [] });
      expect(document!.entries[1]!.tags).toHaveLength(50);
      expect(JSON.stringify(document)).not.toContain(TOKEN);
      expect(JSON.stringify(document)).not.toContain('bogus');
      expect(JSON.stringify(document)).not.toContain('far');
      const { lines } = await list();
      expect(lines.join('\n')).not.toContain('far');
    } finally {
      await app.shutdown();
    }
  });

  it('cuts an entry over 16 KiB', async () => {
    const big = entry('000000008aa0000000008', 'log', 8_000, { level: 'info', message: 'big', context: { items: Array.from({ length: 80 }, (_, i) => `${i} ${'word '.repeat(400)}`) } });
    const { app, list } = await listApp([big]);
    try {
      const { document } = await list({ json: true });
      expect(Buffer.byteLength(JSON.stringify(big.content))).toBeGreaterThan(100_000);
      expect(Buffer.byteLength(JSON.stringify(document!.entries[0]!.content))).toBeLessThanOrEqual(16 * 1024);
    } finally {
      await app.shutdown();
    }
  });
});
