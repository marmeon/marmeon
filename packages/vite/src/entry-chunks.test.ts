import type { Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import { entryChunks } from './entry-chunks.ts';

type Edges = Record<string, { imports?: string[]; dynamic?: string[] }>;

/** A bundler context over a hand-written module graph; `entries` name the modules that start an entry. */
function chunking(edges: Edges, entries: Record<string, string>) {
  const ctx = {
    getModuleInfo: (id: string) => (id in edges ? { importedIds: edges[id]!.imports ?? [], dynamicallyImportedIds: edges[id]!.dynamic ?? [] } : null),
  } as unknown as Rolldown.ChunkingContext;
  const groups = (entryChunks(new Map(Object.entries(entries))) as { groups: { name: (id: string, ctx: Rolldown.ChunkingContext) => string | null; test?: (id: string) => boolean; priority: number }[] }).groups.toSorted((a, b) => b.priority - a.priority);
  /** The chunk the first group that names `id` puts it in, highest priority first. */
  return (id: string): string | null => {
    for (const group of groups) {
      if (group.test !== undefined && !group.test(id)) continue;
      const name = group.name(id, ctx);
      if (name !== null) return name;
    }
    return null;
  };
}

const entries = { '/root/index.html': 'index', '/pkg/client.js': 'pkg-status' };

describe('entryChunks', () => {
  it('puts what one entry alone reaches into that entry\'s chunks, and third-party code into a vendor chunk of it', () => {
    const chunk = chunking(
      {
        '/root/index.html': { imports: ['/root/app.ts', '/root/node_modules/lib/a.js'] },
        '/root/app.ts': {},
        '/root/node_modules/lib/a.js': {},
        '/pkg/client.js': { imports: ['/pkg/own.js', '/pkg/node_modules/dep/b.js'] },
        '/pkg/own.js': {},
        '/pkg/node_modules/dep/b.js': {},
      },
      entries,
    );
    expect(chunk('/root/app.ts')).toBe('index');
    expect(chunk('/root/node_modules/lib/a.js')).toBe('vendor');
    expect(chunk('/pkg/own.js')).toBe('pkg-status');
    expect(chunk('/pkg/node_modules/dep/b.js')).toBe('vendor-pkg-status');
  });

  it('puts what several entries reach into a chunk named by a hash of those entries, never by a namespace', () => {
    const chunk = chunking(
      {
        '/root/index.html': { imports: ['/shared.ts', '/node_modules/react/index.js'] },
        '/pkg/client.js': { imports: ['/shared.ts', '/node_modules/react/index.js'] },
        '/shared.ts': {},
        '/node_modules/react/index.js': {},
      },
      entries,
    );
    expect(chunk('/shared.ts')).toMatch(/^shared-[0-9a-f]{8}$/);
    expect(chunk('/node_modules/react/index.js')).toMatch(/^vendor-shared-[0-9a-f]{8}$/);
  });

  it('tells a module an entry loads first from one it reaches lazily, so the two get chunks of their own', () => {
    // `/pkg/mod.ts` is in the package's first-load graph, and a lazy page of the app imports it.
    const lazy = chunking(
      {
        '/root/index.html': { dynamic: ['/root/page.ts'] },
        '/root/page.ts': { imports: ['/pkg/mod.ts'] },
        '/pkg/client.js': { imports: ['/pkg/mod.ts'] },
        '/pkg/mod.ts': {},
      },
      entries,
    );
    const both = lazy('/pkg/mod.ts')!;
    expect(both).toMatch(/^shared-/);
    // Reached statically by the package only: another combination than a module both reach statically.
    const staticBoth = chunking({ '/root/index.html': { imports: ['/pkg/mod.ts'] }, '/pkg/client.js': { imports: ['/pkg/mod.ts'] }, '/pkg/mod.ts': {} }, entries);
    expect(staticBoth('/pkg/mod.ts')).not.toBe(both);
    // A module only a lazy page of one entry reaches belongs to that entry alone.
    const own = chunking({ '/root/index.html': { dynamic: ['/root/page.ts'] }, '/root/page.ts': {}, '/pkg/client.js': {} }, entries);
    expect(own('/root/page.ts')).toBe('index');
  });

  it('survives an import cycle', () => {
    const chunk = chunking(
      {
        '/root/index.html': { imports: ['/root/a.ts'] },
        '/root/a.ts': { imports: ['/root/b.ts'] },
        '/root/b.ts': { imports: ['/root/a.ts'] },
        '/pkg/client.js': {},
      },
      entries,
    );
    expect(chunk('/root/a.ts')).toBe('index');
    expect(chunk('/root/b.ts')).toBe('index');
  });

  it('names a module no entry reaches nothing, so the bundler\'s own rules apply to it', () => {
    const chunk = chunking({ '/root/index.html': {}, '/pkg/client.js': {}, '/other.ts': {} }, entries);
    expect(chunk('/other.ts')).toBeNull();
  });

  it('reads the graph again for every build', () => {
    const edges: Edges = { '/root/index.html': { imports: ['/m.ts'] }, '/pkg/client.js': {}, '/m.ts': {} };
    expect(chunking(edges, entries)('/m.ts')).toBe('index');
    edges['/pkg/client.js'] = { imports: ['/m.ts'] };
    expect(chunking(edges, entries)('/m.ts')).toMatch(/^shared-/);
  });
});
