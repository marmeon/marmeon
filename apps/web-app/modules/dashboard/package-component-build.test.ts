import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { appCopy } from '../../../../packages/react/src/__fixtures__/bundle.ts';

// No trailing separator: the copy's filter reads paths relative to it.
const source = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const cli = fileURLToPath(new URL('../../../../packages/cli/bin/marmeon.js', import.meta.url));

type Chunk = { file: string; css?: string[]; imports?: string[]; isEntry?: boolean };

const files = (dir: string, extension: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith(extension))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');

describe('a component of a package with a namespace, in the production build of the app', () => {
  it('has its route name in the browser manifest, its stylesheet in the chunk of the page, and no loose import in the server bundle', () => {
    // A copy of the app: the build writes `dist/`, `.marmeon/` and `bootstrap/routes.ts`, which a test booting the app or a developer's own `dist` must not meet.
    const app = appCopy(source, workspaceTempDir('marmeon-app-web-app-'));
    try {
      // As an app builds: a fresh process without the test environment. The type check is the typecheck job's.
      const env: Record<string, string | undefined> = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV' || key === 'NODE_OPTIONS') delete env[key];
      const built = spawnSync(process.execPath, [cli, 'build', '--no-typecheck'], { cwd: app, env, encoding: 'utf8', timeout: 240_000 });
      expect(`${built.stdout}${built.stderr}`).toContain('Built dist/client and dist/server');
      expect(built.status).toBe(0);

      // `auth.sensitive` is named by no client code of the app, only by the component of the package.
      expect(files(join(app, 'dist/client/assets'), '.js')).toContain('/settings/sensitive');

      const manifest = JSON.parse(readFileSync(join(app, 'dist/client/.vite/manifest.json'), 'utf8')) as Record<string, Chunk>;
      const page = manifest['modules/dashboard/views/Show.tsx']!;
      // The stylesheets a chunk loads at once: its own and those of the chunks it imports (the package's area imports the component too, so its stylesheet lies in a chunk both share).
      const css = (chunk: Chunk, seen = new Set<Chunk>()): string => {
        if (seen.has(chunk)) return '';
        seen.add(chunk);
        const own = (chunk.css ?? []).map((file) => readFileSync(join(app, 'dist/client', file), 'utf8')).join('\n');
        return [own, ...(chunk.imports ?? []).map((key) => css(manifest[key]!, seen))].join('\n');
      };
      expect(css(page)).toContain('.status-board');
      // Not in the stylesheet every page loads.
      expect(css(manifest['index.html']!)).not.toContain('.status-board');

      // Bundled with the app, not left for Node to import: no stylesheet import, no bare package import.
      const server = files(join(app, 'dist/server'), '.js');
      expect(server).toContain('data-badge');
      expect(server).not.toMatch(/(?:from|import)\s*["'](?:@fixtures\/status-board|[^"']*\.css)["']/);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  }, 300_000);
});
