import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { BUILT_IN } from './built-in.ts';
import { CommandArgumentsError, type CommandInput } from './command.ts';
import { MakeResourceCommand } from './commands/make-resource.ts';
import { webApp } from './__fixtures__/cli.js';

const APP = `import { defineApplication } from '@marmeon/core';
import auth from '#modules/auth';

export default defineApplication({
  root: import.meta.dirname,
  modules: [auth],
});
`;

/** The skeleton `make:resource` needs: the auth module, a layout (at the kit's place or at the root) and the entry. */
function app(options: { auth?: boolean; layout?: 'kit' | 'root' | 'none'; dependency?: boolean } = {}): string {
  const root = tempDir('marmeon-make-resource-');
  const { auth = true, layout = 'root', dependency = true } = options;
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: dependency ? { '@marmeon/auth': 'workspace:*' } : {} }));
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(join(root, 'bootstrap/app.ts'), APP);
  if (auth) {
    mkdirSync(join(root, 'modules/auth'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/index.ts'), "export default {};\n");
  }
  if (layout === 'kit') {
    mkdirSync(join(root, 'modules/auth/layouts'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/layouts/AppLayout.tsx'), 'export {};\n');
  } else if (layout === 'root') {
    mkdirSync(join(root, 'layouts'));
    writeFileSync(join(root, 'layouts/AppLayout.tsx'), 'export {};\n');
  }
  return root;
}

function run(root: string, args: string[], options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  let code: number;
  try {
    code = new MakeResourceCommand().handle({ root, args, options, output } as unknown as CommandInput);
  } catch (error) {
    // What `marmeon` does with an argument the command refuses: the message on stderr, exit 2.
    if (!(error instanceof CommandArgumentsError)) throw error;
    output.error(error.message);
    code = 2;
  }
  return { code, lines: lines.map((line) => stripVTControlCharacters(line)) };
}

/** Every file below a directory, relative, with the timestamp of a migration's name replaced. */
function tree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path).replace(/\/\d{4}_\d\d_\d\d_\d{6}_/, '/STAMP_'), readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return files;
}

/** Everything under the root, to show that a refused run wrote nothing. */
function snapshot(root: string): Map<string, string> {
  return tree(root);
}

describe('make:resource and links out of the project', () => {
  it('writes nothing when bootstrap/app.ts is a link out', () => {
    const root = app();
    const outside = tempDir('marmeon-make-resource-outside-');
    writeFileSync(join(outside, 'app.ts'), APP);
    rmSync(join(root, 'bootstrap/app.ts'));
    symlinkSync(join(outside, 'app.ts'), join(root, 'bootstrap/app.ts'));
    const { code, lines } = run(root, ['Bookmark']);
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bootstrap/app.ts leads out of the project');
    expect(readdirSync(join(root, 'modules'))).toEqual(['auth']);
    expect(readFileSync(join(outside, 'app.ts'), 'utf8')).toBe(APP);
  });
});

describe('make:resource', () => {
  it('is a built-in command that does not boot the app', () => {
    expect(BUILT_IN).toContain(MakeResourceCommand);
    expect(MakeResourceCommand.command).toBe('make:resource');
    expect(MakeResourceCommand.boots).toBe(false);
  });

  it('writes the module of the web app byte for byte, and registers it', () => {
    const root = app();
    const { code, lines } = run(root, ['Bookmark']);
    expect(code).toBe(0);
    const generated = tree(join(root, 'modules/bookmarks'));
    const shown = tree(join(webApp, 'modules/bookmarks'));
    // No file more, none less, none different.
    expect([...generated.keys()].sort()).toEqual([...shown.keys()].sort());
    for (const [path, contents] of shown) expect(generated.get(path), path).toBe(contents);
    const entry = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8');
    expect(entry).toContain("import bookmarks from '#modules/bookmarks';");
    expect(entry).toMatch(/modules: \[auth, bookmarks\]/);
    const shownEntry = readFileSync(join(webApp, 'bootstrap/app.ts'), 'utf8');
    expect(shownEntry).toContain("import bookmarks from '#modules/bookmarks';");
    expect(shownEntry).toMatch(/modules: \[[^\]]*, bookmarks[,\]]/);
    const text = lines.join('\n');
    expect(text).toContain('Created modules/bookmarks/controllers/ListBookmarksController.ts');
    expect(text).toContain('marmeon migrate');
    expect(text).toContain('marmeon route:types');
    expect(text).toContain('pnpm test modules/bookmarks');
  });

  it('writes these files and no others', () => {
    const root = app();
    expect(run(root, ['Bookmark']).code).toBe(0);
    expect([...tree(join(root, 'modules/bookmarks')).keys()].sort()).toEqual([
      'BookmarkRepository.ts',
      'bookmarks.test.ts',
      'controllers/CreateBookmarkController.ts',
      'controllers/DeleteBookmarkController.ts',
      'controllers/EditBookmarkController.ts',
      'controllers/ListBookmarksController.ts',
      'controllers/StoreBookmarkController.ts',
      'controllers/UpdateBookmarkController.ts',
      'index.ts',
      'migrations/STAMP_create_bookmarks_table.ts',
      'policies/BookmarkPolicy.ts',
      'routes.ts',
      'views/Form.tsx',
      'views/ListBookmarks.tsx',
    ]);
  });

  it.each([
    ['Bookmark', 'bookmarks', 'bookmarks', 'bookmark', 'ListBookmarksController'],
    ['Category', 'categories', 'categories', 'category', 'ListCategoriesController'],
    ['Box', 'boxes', 'boxes', 'box', 'ListBoxesController'],
    ['Day', 'days', 'days', 'day', 'ListDaysController'],
    ['BlogPost', 'blog-posts', 'blog_posts', 'blogPost', 'ListBlogPostsController'],
    ['HTMLPage', 'html-pages', 'html_pages', 'htmlPage', 'ListHTMLPagesController'],
  ])('names %s: module %s, table %s, parameter %s', (name, module, table, param, list) => {
    const root = app();
    expect(run(root, [name]).code).toBe(0);
    const files = tree(join(root, 'modules', module));
    expect(files.has(`controllers/${list}.ts`)).toBe(true);
    expect(files.get('migrations/STAMP_create_' + table + '_table.ts')).toContain(`schema.create('${table}'`);
    expect(files.get(`${name}Repository.ts`)).toContain(`Repository<'${table}'>`);
    expect(files.get('routes.ts')).toContain(`.bind('${param}', ${name}Repository)`);
    expect(files.get('routes.ts')).toContain(`.prefix('/${module}')`);
    expect(files.get('routes.ts')).toContain(`.name('${module}.')`);
  });

  it('takes the module from --module and keeps the names of the record', () => {
    const root = app();
    expect(run(root, ['Bookmark'], { module: 'saved-links' }).code).toBe(0);
    const files = tree(join(root, 'modules/saved-links'));
    expect(files.get('index.ts')).toContain("name: 'saved-links'");
    expect(files.get('migrations/STAMP_create_saved_links_table.ts')).toContain("schema.create('saved_links'");
    expect(files.get('controllers/ListBookmarksController.ts')).toContain("this.view('saved-links/ListBookmarks'");
    expect(files.has('saved-links.test.ts')).toBe(true);
    expect(existsSync(join(root, 'modules/bookmarks'))).toBe(false);
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toContain("import savedLinks from '#modules/saved-links';");
  });

  it('imports the layout from where the app keeps it', () => {
    const kit = app({ layout: 'kit' });
    expect(run(kit, ['Bookmark']).code).toBe(0);
    expect(readFileSync(join(kit, 'modules/bookmarks/views/Form.tsx'), 'utf8')).toContain("from '../../auth/layouts/AppLayout.tsx'");
    const moved = app({ layout: 'root' });
    expect(run(moved, ['Bookmark']).code).toBe(0);
    expect(readFileSync(join(moved, 'modules/bookmarks/views/ListBookmarks.tsx'), 'utf8')).toContain("from '../../../layouts/AppLayout.tsx'");
  });

  describe('what it writes lets the owner in and nobody else', () => {
    const files = () => {
      const root = app();
      expect(run(root, ['Bookmark']).code).toBe(0);
      return tree(join(root, 'modules/bookmarks'));
    };

    it('answers every ability of the policy with a 404 for anyone but the owner', () => {
      const policy = files().get('policies/BookmarkPolicy.ts')!;
      expect(policy).toContain("import type { Row } from '@marmeon/database';");
      for (const ability of ['view', 'update', 'delete']) {
        expect(policy).toContain(`${ability}(user: AuthUser, record: Row<'bookmarks'>) {\n    return record.user_id === user.id || denyAsNotFound();`);
      }
      expect(policy).not.toMatch(/return true|=> true/);
    });

    it('decides every route that takes a record from the path, and only the three that take none are open', () => {
      const generated = files();
      const routes = generated.get('routes.ts')!;
      expect(routes.match(/authorize\(everyone\)/g)).toHaveLength(1);
      expect(routes).toContain("const bookmark = bookmarks.bind('bookmark', BookmarkRepository);");
      for (const route of ["bookmark.get('/:bookmark/edit'", "bookmark.put('/:bookmark'", "bookmark.delete('/:bookmark'"]) expect(routes).toContain(route);
      expect(routes).toContain(".middleware(authenticate()).middleware(verified())");
      for (const [controller, ability] of [['Edit', 'update'], ['Update', 'update'], ['Delete', 'delete']] as const) {
        expect(generated.get(`controllers/${controller}BookmarkController.ts`)).toContain(`authorize: can(BookmarkPolicy, '${ability}', 'bookmark')`);
      }
    });

    it('lists only the records of the signed-in user and takes the owner from the session, never from the form', () => {
      const generated = files();
      expect(generated.get('BookmarkRepository.ts')).toContain(".where('user_id', '=', userId)");
      expect(generated.get('controllers/ListBookmarksController.ts')).toContain('pageOf(ctx.user.id, ctx.query)');
      const store = generated.get('controllers/StoreBookmarkController.ts')!;
      expect(store).toContain('insert({ user_id: ctx.user.id, title: ctx.body.title })');
      for (const controller of ['Store', 'Update']) expect(generated.get(`controllers/${controller}BookmarkController.ts`)).not.toMatch(/user_id: r\./);
      expect(generated.get('migrations/STAMP_create_bookmarks_table.ts')).toContain('table.uuidId();');
      expect(generated.get('migrations/STAMP_create_bookmarks_table.ts')).toContain("constrained('users').cascadeOnDelete()");
    });

    it('tests the other user for every route that takes a record', () => {
      const test = files().get('bookmarks.test.ts')!;
      expect(test).toContain("createTestApp(application, { database: 'refresh' })");
      expect(test).toContain("somebody else's bookmark, however it is reached");
      for (const call of ['asAda.get(`/bookmarks/${bookmark.id}/edit`)', 'asAda.put(`/bookmarks/${bookmark.id}`', 'asAda.delete(`/bookmarks/${bookmark.id}`)']) {
        expect(test).toContain(call);
      }
      expect(test).toContain('.assertNotFound()');
    });
  });

  it.each(['bookmark', 'bookmarks', '../Evil', "A'B", 'A B', 'A-B', 'A_B', 'a', ''])('refuses the name %j and writes nothing', (name) => {
    const root = app();
    const before = snapshot(root);
    const { code } = run(root, name === '' ? [] : [name]);
    expect(code).toBe(2);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, 'modules/bookmarks'))).toBe(false);
  });

  it.each(['Class', 'Title', 'Form', 'App', 'Mine', 'Delete', 'Everyone', 'Expect', 'AsAda', 'Verified', 'Can'])('refuses %s, a word the generated code uses itself', (name) => {
    const root = app();
    const before = snapshot(root);
    const { code, lines } = run(root, [name]);
    expect([code, lines.join('\n')]).toEqual([2, expect.stringContaining('name the record more precisely')]);
    expect(snapshot(root)).toEqual(before);
  });

  it.each(['../x', 'A', 'a b', "a'b", 'x/y', '-a', 'a--b'])('refuses --module=%j and writes nothing', (module) => {
    const root = app();
    const before = snapshot(root);
    expect(run(root, ['Bookmark'], { module }).code).toBe(2);
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses an existing module and changes nothing in it', () => {
    const root = app();
    mkdirSync(join(root, 'modules/bookmarks'));
    writeFileSync(join(root, 'modules/bookmarks/index.ts'), 'mine');
    const before = snapshot(root);
    const { code, lines } = run(root, ['Bookmark']);
    expect([code, lines.join('\n')]).toEqual([1, expect.stringContaining('modules/bookmarks already exists')]);
    expect(snapshot(root)).toEqual(before);
    expect(run(root, ['Bookmark'], { force: true }).code).toBe(1);
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    ['without @marmeon/auth in the dependencies', { dependency: false }],
    ['without the auth module', { auth: false }],
    ['without a layout', { layout: 'none' as const }],
  ])('refuses %s and writes nothing', (_title, options) => {
    const root = app(options);
    const before = snapshot(root);
    const { code, lines } = run(root, ['Bookmark']);
    expect([code, lines.join('\n')]).toEqual([1, expect.stringContaining('it needs the auth module (marmeon make:auth)')]);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, 'modules/bookmarks'))).toBe(false);
  });

  it('refuses a table the app already has and writes nothing', () => {
    const root = app();
    writeFileSync(join(root, 'bootstrap/database.d.ts'), "declare module '@marmeon/database' {\n  interface Tables {\n    users: {\n      id: number;\n    };\n  }\n  interface Relations {}\n}\n");
    const before = snapshot(root);
    const { code, lines } = run(root, ['Account'], { module: 'users' });
    expect([code, lines.join('\n')]).toEqual([1, expect.stringContaining('The table users already exists')]);
    expect(snapshot(root)).toEqual(before);
    expect(run(root, ['Bookmark']).code).toBe(0);
  });

  it('prints the lines to add by hand with --no-register', () => {
    const root = app();
    const before = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8');
    const { code, lines } = run(root, ['Bookmark'], { 'no-register': true });
    expect(code).toBe(0);
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toBe(before);
    expect(lines.join('\n')).toContain("import bookmarks from '#modules/bookmarks';");
  });
});
