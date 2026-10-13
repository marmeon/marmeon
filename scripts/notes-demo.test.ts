import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyOverlay, checkDemo, marmeonArguments, OVERLAY, readCommands, readEdits, sampleNotes, type DemoTarget } from './notes-demo.ts';
import { leave, SmokeError } from './pack-smoke.ts';
import { tempDir } from './test/temp-dir.js';

/** An overlay with these files, edits and commands, and an app with these files. */
function setup({ files = {}, edits = [], commands = { beforeCopy: [], afterCopy: [] }, app = {} }: { files?: Record<string, string>; edits?: unknown; commands?: unknown; app?: Record<string, string> }) {
  const dir = tempDir('marmeon-notes-');
  const overlay = join(dir, 'overlay');
  const target = join(dir, 'app');
  const put = (root: string, name: string, text: string) => {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  mkdirSync(join(overlay, 'files'), { recursive: true });
  mkdirSync(target, { recursive: true });
  for (const [name, text] of Object.entries(files)) put(join(overlay, 'files'), name, text);
  for (const [name, text] of Object.entries(app)) put(target, name, text);
  writeFileSync(join(overlay, 'edits.json'), JSON.stringify(edits));
  writeFileSync(join(overlay, 'commands.json'), JSON.stringify(commands));
  return { overlay, app: target };
}

describe('the notes demo overlay', () => {
  it('copies the files, applies the edits and runs the commands in order — and says what it wrote', () => {
    const { overlay, app } = setup({
      files: { 'modules/notes/index.ts': 'export {};\n', 'modules/notes/views/Index.tsx': '<main />\n' },
      edits: [{ file: 'layout.tsx', find: 'before', replace: 'before\nafter' }],
      commands: { beforeCopy: ['marmeon make:module notes'], afterCopy: ['marmeon migrate', 'marmeon route:types'] },
      app: { 'layout.tsx': '<nav>before</nav>\n' },
    });
    const ran: string[] = [];
    const written = applyOverlay(app, (args) => ran.push(`${args.join(' ')} ${existsSync(join(app, 'modules/notes/index.ts')) ? 'copied' : 'not copied'}`), overlay);
    expect(written.sort()).toEqual(['modules/notes/index.ts', 'modules/notes/views/Index.tsx']);
    expect(readFileSync(join(app, 'modules/notes/index.ts'), 'utf8')).toBe('export {};\n');
    expect(readFileSync(join(app, 'layout.tsx'), 'utf8')).toBe('<nav>before\nafter</nav>\n');
    expect(ran).toEqual(['make:module notes not copied', 'migrate copied', 'route:types copied']);
  });

  it('names the file and the count when an edit finds its text not exactly once', () => {
    const none = setup({ edits: [{ file: 'layout.tsx', find: 'missing', replace: 'x' }], app: { 'layout.tsx': 'text' } });
    expect(() => applyOverlay(none.app, () => undefined, none.overlay)).toThrow(/layout\.tsx: the text to replace occurs 0 times/);
    const twice = setup({ edits: [{ file: 'layout.tsx', find: 'twice', replace: 'x' }], app: { 'layout.tsx': 'twice and twice' } });
    expect(() => applyOverlay(twice.app, () => undefined, twice.overlay)).toThrow(/layout\.tsx: the text to replace occurs 2 times/);
    const absent = setup({ edits: [{ file: 'nowhere.tsx', find: 'x', replace: 'y' }] });
    expect(() => applyOverlay(absent.app, () => undefined, absent.overlay)).toThrow(/nowhere\.tsx: the overlay edits a file the starter kit does not have/);
  });

  it('refuses a command that is not a marmeon line — before it touches the app', () => {
    const { overlay, app } = setup({ files: { 'a.ts': 'x' }, commands: { beforeCopy: ['marmeon migrate'], afterCopy: ['rm -rf /'] } });
    expect(() => applyOverlay(app, () => undefined, overlay)).toThrow(SmokeError);
    expect(() => applyOverlay(app, () => undefined, overlay)).toThrow(/"rm -rf \/" is not a "marmeon <command>/);
    expect(existsSync(join(app, 'a.ts'))).toBe(false);
    for (const line of ['pnpm migrate', 'marmeon', 'marmeon migrate; rm x', 'marmeon migrate && ls', 'marmeon $(ls)', 'node marmeon migrate']) {
      expect(() => marmeonArguments(line, 'commands.json'), line).toThrow(SmokeError);
    }
    expect(marmeonArguments('marmeon migrate:fresh --seed', 'x')).toEqual(['migrate:fresh', '--seed']);
  });

  it('refuses a commands.json without both lists, and an edit outside the app', () => {
    const lists = setup({ commands: { beforeCopy: [] } });
    expect(() => readCommands(lists.overlay)).toThrow(/"afterCopy" must be a list/);
    const outside = setup({ edits: [{ file: '../elsewhere.ts', find: 'x', replace: 'y' }] });
    expect(() => readEdits(outside.overlay)).toThrow(/must be a file of the app itself/);
    const empty = setup({ edits: [{ file: 'a.ts', find: '', replace: 'y' }] });
    expect(() => readEdits(empty.overlay)).toThrow(/non-empty "find"/);
    for (const file of ['/etc/passwd', '', '.', './', 'node_modules/x/index.js', './node_modules/x/index.js', 'a/../../b.ts']) {
      const refused = setup({ edits: [{ file, find: 'x', replace: 'y' }] });
      expect(() => readEdits(refused.overlay), file).toThrow(/must be a file of the app itself/);
    }
  });
});

/** A smoke app that records what runs, answers `output` for the tests, and answers `/notes` as `notesAnswer` says. */
function target(app: string, output: string, notesAnswer: (response: ServerResponse) => void): { target: DemoTarget; ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    target: {
      app,
      run: (command, args) => {
        ran.push([command, ...args].join(' '));
        return args.includes('test') ? output : '';
      },
      buildWithoutEnv: () => {
        ran.push('build');
        return '';
      },
      serve: async (path, check) => {
        const server = createServer((request, response) => (request.url === '/notes' ? notesAnswer(response) : response.end('ok')));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          ran.push(`serve ${path}`);
          await check?.(`http://127.0.0.1:${(server.address() as { port: number }).port}`, () => '');
        } finally {
          server.close();
        }
      },
    },
  };
}

describe('the demo check', () => {
  const overlay = () => setup({ files: { 'modules/notes/index.ts': 'x' }, commands: { beforeCopy: ['marmeon make:module notes'], afterCopy: ['marmeon migrate'] } });
  const toLogin = (response: ServerResponse) => response.writeHead(302, { location: '/login' }).end();
  const passed = ' ✓ modules/notes/notes.test.ts > a test\n Tests  11 passed (11)';

  it("applies the overlay with pm exec, runs the app's checks and the start", async () => {
    const { overlay: dir, app } = overlay();
    const { target: smoke, ran } = target(app, passed, toLogin);
    await checkDemo(smoke, 'pnpm', dir);
    expect(ran).toEqual([
      'pnpm exec marmeon make:module notes',
      'pnpm exec marmeon migrate',
      'pnpm run test --reporter=verbose',
      'pnpm run typecheck',
      'pnpm run lint --deny-warnings',
      'build',
      'serve /',
    ]);
  });

  it("is red when the notes module's tests did not run, or the run did not pass", async () => {
    const { overlay: dir, app } = overlay();
    await expect(checkDemo(target(app, ' ✓ modules/home/home.test.ts\n Tests  9 passed (9)', toLogin).target, 'pnpm', dir)).rejects.toThrow(/did not run the notes module's tests/);
    await expect(checkDemo(target(app, ' ✓ modules/notes/notes.test.ts\n no summary', toLogin).target, 'pnpm', dir)).rejects.toThrow(/did not pass/);
  });

  it('is red when a guest is not sent to /login', async () => {
    const { overlay: dir, app } = overlay();
    const open = (response: ServerResponse) => response.writeHead(200).end('notes');
    await expect(checkDemo(target(app, passed, open).target, 'pnpm', dir)).rejects.toThrow(/GET \/notes as a guest answered 200/);
  });
});

describe('the sample notes of a kept app', () => {
  it('adds the notes of the seeded test user — and fails when the seeder made none', () => {
    const app = tempDir('marmeon-notes-');
    mkdirSync(join(app, 'storage'), { recursive: true });
    const file = join(app, 'storage/database.sqlite');
    const database = new DatabaseSync(file);
    database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, body TEXT, pinned INTEGER, created_at TEXT, updated_at TEXT)');
    database.close();
    expect(() => sampleNotes(app, () => undefined)).toThrow(/made no test user/);
    const ran: string[][] = [];
    sampleNotes(app, (args) => {
      ran.push(args);
      const seeded = new DatabaseSync(file);
      seeded.prepare('INSERT INTO users (email) VALUES (?)').run('test@example.com');
      seeded.close();
    });
    expect(ran).toEqual([['db:seed']]);
    const check = new DatabaseSync(file);
    const rows = check.prepare('SELECT user_id, title, pinned FROM notes ORDER BY id').all() as { user_id: number; title: string; pinned: number }[];
    check.close();
    expect(rows.map((row) => [row.user_id, row.title, row.pinned])).toEqual([
      [1, 'Groceries', 0],
      [1, 'Ideas', 1],
      [1, 'Call the dentist', 0],
    ]);
  });
});

describe('the end of a smoke run', () => {
  it('removes the directory unless it is kept — and names a kept one, with the sample user only when there is one', () => {
    const lines: string[] = [];
    const gone = tempDir('marmeon-notes-');
    leave(gone, false, true, (line) => lines.push(line));
    expect(existsSync(gone)).toBe(false);
    expect(lines).toEqual([]);

    const kept = tempDir('marmeon-notes-');
    leave(kept, true, false, (line) => lines.push(line));
    expect(existsSync(kept)).toBe(true);
    expect(lines).toEqual([`pack:smoke: kept ${kept}`]);
    leave(kept, true, true, (line) => lines.push(line));
    expect(existsSync(kept)).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('test@example.com');
  });
});

describe('examples/notes', () => {
  it('has commands and edits the demo can run, and edits that fit the starter kit it is applied to', () => {
    expect(readCommands(OVERLAY).beforeCopy).toEqual(['marmeon make:module notes']);
    const layout = readFileSync(fileURLToPath(new URL('../packages/auth/stubs/react/modules/auth/layouts/AppLayout.tsx', import.meta.url)), 'utf8');
    for (const edit of readEdits(OVERLAY)) {
      expect(edit.file).toBe('modules/auth/layouts/AppLayout.tsx');
      expect(layout.split(edit.find).length - 1, edit.find).toBe(1);
    }
  });

  it('styles its pages with the kit, not with inline styles', () => {
    for (const view of ['Index', 'Form']) {
      expect(readFileSync(join(OVERLAY, `files/modules/notes/views/${view}.tsx`), 'utf8')).not.toMatch(/\bstyle=/);
    }
  });
});
