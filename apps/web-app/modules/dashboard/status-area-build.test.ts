import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { appCopy } from '../../../../packages/react/src/__fixtures__/bundle.ts';

// No trailing separator: the copy's filter reads paths relative to it.
const source = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const cli = fileURLToPath(new URL('../../../../packages/cli/bin/marmeon.js', import.meta.url));

interface Chunk {
  file: string;
  css?: string[];
  imports?: string[];
  dynamicImports?: string[];
}

describe("the status board package's area, in the production build of the app", () => {
  it("keeps the area's code and texts out of everything the app's documents can load, and lists the area's entry", () => {
    // A copy of the app: the build writes `dist/`, `.marmeon/` and `bootstrap/routes.ts`, which a test booting the app or a developer's own `dist` must not meet.
    const app = appCopy(source, workspaceTempDir('marmeon-app-web-app-'));
    try {
      // As an app builds: a fresh process without the test environment. The type check is the typecheck job's.
      const env: Record<string, string | undefined> = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV' || key === 'NODE_OPTIONS') delete env[key];
      const built = spawnSync(process.execPath, [cli, 'build', '--no-typecheck'], { cwd: app, env, encoding: 'utf8', timeout: 240_000 });
      expect(`${built.stdout}${built.stderr}`).toContain('Built dist/client and dist/server');
      expect(built.status).toBe(0);

      const client = join(app, 'dist/client');
      const manifest = JSON.parse(readFileSync(join(client, '.vite/manifest.json'), 'utf8')) as Record<string, Chunk>;
      const entries = JSON.parse(readFileSync(join(client, '.vite/marmeon-entries.json'), 'utf8')) as { format: number; entries: Record<string, { client: string }>; pages: Record<string, string> };

      // The area has an entry of its own and a server bundle of its own; its page is listed.
      expect(entries.format).toBe(1);
      expect(Object.keys(entries.entries)).toEqual(['status']);
      expect(Object.keys(entries.pages)).toEqual(['status::Index']);
      for (const key of [entries.entries.status!.client, ...Object.values(entries.pages)]) expect(manifest[key], key).toBeDefined();
      expect(existsSync(join(app, 'dist/server/ssr-status.js'))).toBe(true);

      /** The files of the chunks `key` loads: through static imports only (what its document loads at once), or through every import. */
      const reach = (key: string, dynamic: boolean): Set<string> => {
        const files = new Set<string>();
        const seen = new Set<string>();
        const visit = (name: string) => {
          if (seen.has(name)) return;
          seen.add(name);
          const chunk = manifest[name]!;
          files.add(chunk.file);
          for (const css of chunk.css ?? []) files.add(css);
          for (const next of [...(chunk.imports ?? []), ...(dynamic ? (chunk.dynamicImports ?? []) : [])]) visit(next);
        };
        visit(key);
        return files;
      };
      const publicStatic = reach('index.html', false);
      const publicAll = reach('index.html', true);
      const areaStatic = reach(entries.entries.status!.client, false);
      const areaAll = reach(entries.entries.status!.client, true);

      // What only the area's document loads at once is in no chunk of the app's first page, and the stylesheets stay apart.
      const areaOnly = [...areaStatic].filter((file) => !publicStatic.has(file));
      expect(areaOnly.length).toBeGreaterThan(0);
      expect(areaOnly.some((file) => file.endsWith('.js'))).toBe(true);
      for (const file of areaOnly) expect(publicAll.has(file), file).toBe(false);

      // The document of the app names only files its own entry loads, never one that only the area's does.
      const index = readFileSync(join(client, 'index.html'), 'utf8');
      const named = [...index.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]!);
      expect(named.length).toBeGreaterThan(0);
      for (const file of named) {
        expect(publicStatic.has(file), file).toBe(true);
        expect(areaOnly.includes(file), file).toBe(false);
      }

      // The area's view and texts (the package's, in both languages, and the app's rewording) are in the area's graph and nowhere in the app's.
      const assets = readdirSync(join(client, 'assets')).filter((file) => file.endsWith('.js'));
      const markers = ['data-area', 'Service status', 'Dienststatus', 'Systemzustand', 'Back to the app', 'Zurück zur App', 'Every service the board watches', 'Jeder Dienst'];
      for (const marker of markers) {
        const holding = assets.filter((file) => readFileSync(join(client, 'assets', file), 'utf8').includes(marker)).map((file) => `assets/${file}`);
        expect(holding.filter((file) => areaAll.has(file)).length, marker).toBeGreaterThan(0);
        expect(holding.filter((file) => publicAll.has(file)), marker).toEqual([]);
      }
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  }, 300_000);
});
