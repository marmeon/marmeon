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

describe('the back office package, in the production build of the app', () => {
  it('keeps the back office’s pages and texts out of everything the customers’ documents can load, and lists its entry', () => {
    // A copy of the app: the build writes `dist/`, `.marmeon/` and `bootstrap/routes.ts`, which a test booting the app must not meet.
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
      const entries = JSON.parse(readFileSync(join(client, '.vite/marmeon-entries.json'), 'utf8')) as { entries: Record<string, { client: string }>; pages: Record<string, string> };

      // The back office has an entry and a server bundle of its own, and every page of it is listed.
      expect(Object.keys(entries.entries).sort()).toEqual(['office', 'status']);
      expect(Object.keys(entries.pages).filter((page) => page.startsWith('office::')).sort()).toEqual(['office::Confirm', 'office::Login', 'office::Overview', 'office::Secure', 'office::Sessions']);
      for (const key of [entries.entries.office!.client, ...Object.entries(entries.pages).filter(([page]) => page.startsWith('office::')).map(([, file]) => file)]) expect(manifest[key], key).toBeDefined();
      expect(existsSync(join(app, 'dist/server/ssr-office.js'))).toBe(true);

      /** The files of the chunks `key` loads, through every import. */
      const reach = (key: string): Set<string> => {
        const files = new Set<string>();
        const visit = (name: string) => {
          const chunk = manifest[name]!;
          if (files.has(chunk.file)) return;
          files.add(chunk.file);
          for (const css of chunk.css ?? []) files.add(css);
          for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(next);
        };
        visit(key);
        return files;
      };
      const publicAll = reach('index.html');
      const officeAll = reach(entries.entries.office!.client);

      // Its texts (the package's, in both languages) and its views are in its graph and in no chunk a document of the app loads.
      const assets = readdirSync(join(client, 'assets')).filter((file) => file.endsWith('.js'));
      const markers = ['Back office sign-in', 'Anmeldung im Back Office', 'For editors only', 'Nur für die Redaktion', 'asks for your back office password again', 'fragt noch einmal nach deinem Passwort im Back Office', 'data-area'];
      for (const marker of markers) {
        const holding = assets.filter((file) => readFileSync(join(client, 'assets', file), 'utf8').includes(marker)).map((file) => `assets/${file}`);
        expect(holding.filter((file) => officeAll.has(file)).length, marker).toBeGreaterThan(0);
        expect(holding.filter((file) => publicAll.has(file)), marker).toEqual([]);
      }
      // The app's own document never names a file of the back office's entry.
      const index = readFileSync(join(client, 'index.html'), 'utf8');
      expect(index).not.toContain('office');
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  }, 300_000);
});
