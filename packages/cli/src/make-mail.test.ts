import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { BUILT_IN } from './built-in.ts';
import { CommandArgumentsError, type CommandInput } from './command.ts';
import { MakeMailCommand } from './commands/make.ts';

function app(manifest: string | null = JSON.stringify({ dependencies: { '@marmeon/mail': 'workspace:*', '@marmeon/i18n': 'workspace:*' } })): string {
  const root = tempDir('marmeon-make-mail-');
  mkdirSync(join(root, 'modules', 'notes'), { recursive: true });
  if (manifest !== null) writeFileSync(join(root, 'package.json'), manifest);
  return root;
}

function run(root: string, args: string[], options: Record<string, unknown> = { module: 'notes' }) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  let code: number;
  try {
    code = new MakeMailCommand().handle({ root, args, options, output } as unknown as CommandInput);
  } catch (error) {
    if (!(error instanceof CommandArgumentsError)) throw error;
    output.error(error.message);
    code = 2;
  }
  return { code, lines: lines.map((line) => stripVTControlCharacters(line)) };
}

describe('make:mail', () => {
  it('is a built-in command that does not boot the app', () => {
    expect(BUILT_IN).toContain(MakeMailCommand);
    expect(MakeMailCommand.command).toBe('make:mail');
    expect(MakeMailCommand.boots).toBe(false);
  });

  it('writes the mail with a preview, and the layout', () => {
    const root = app();
    const { code, lines } = run(root, ['NoteShared']);
    expect(code).toBe(0);
    expect(lines).toContain('✓ Created modules/notes/mail/NoteSharedMail.ts');
    expect(lines).toContain('✓ Created modules/notes/mail/layout.ts');
    expect(lines.join('\n')).toContain('/_marmeon/mail/notes/NoteSharedMail');
    const mail = readFileSync(join(root, 'modules/notes/mail/NoteSharedMail.ts'), 'utf8');
    expect(mail).toContain('export class NoteSharedMail implements Mailable {');
    expect(mail).toContain('static preview({ make, locale }: MailPreviewContext): NoteSharedMail {');
    expect(mail).toContain('make(Translators).for(locale))');
    expect(mail).toContain('return layout(t, {');
    const layout = readFileSync(join(root, 'modules/notes/mail/layout.ts'), 'utf8');
    expect(layout).toContain('{ preview, body }: { preview: string; body: Html }');
    expect(layout).not.toContain('Marmeon');
  });

  it('keeps a name that already ends in Mail', () => {
    const root = app();
    expect(run(root, ['WelcomeMail']).code).toBe(0);
    expect(existsSync(join(root, 'modules/notes/mail/WelcomeMail.ts'))).toBe(true);
  });

  it('never overwrites the mail or the layout', () => {
    const root = app();
    run(root, ['NoteShared']);
    const layout = join(root, 'modules/notes/mail/layout.ts');
    writeFileSync(layout, '// mine\n');
    const second = run(root, ['NoteShared']);
    expect([second.code, second.lines]).toEqual([1, ['✗ modules/notes/mail/NoteSharedMail.ts already exists (use --force to overwrite).']]);
    const other = run(root, ['NoteRead']);
    expect(other.code).toBe(0);
    expect(other.lines).not.toContain('✓ Created modules/notes/mail/layout.ts');
    expect(run(root, ['NoteShared'], { module: 'notes', force: true }).code).toBe(0);
    expect(readFileSync(layout, 'utf8')).toBe('// mine\n');
  });

  it('writes nothing and says what to add when the app has no @marmeon/mail', () => {
    for (const manifest of [JSON.stringify({ dependencies: {} }), null]) {
      const root = app(manifest);
      const { code, lines } = run(root, ['NoteShared']);
      expect(code).toBe(1);
      expect(lines).toEqual(['✗ A mail is sent by the Mailer of @marmeon/mail: pnpm add -E @marmeon/mail@<version of your app>']);
      expect(existsSync(join(root, 'modules/notes/mail'))).toBe(false);
    }
  });

  it('writes nothing and says what to add when the app has no @marmeon/i18n', () => {
    const root = app(JSON.stringify({ dependencies: { '@marmeon/mail': 'workspace:*' } }));
    const { code, lines } = run(root, ['NoteShared']);
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ A mail speaks the language of its recipient with the Translators of @marmeon/i18n: pnpm add -E @marmeon/i18n@<version of your app>']);
    expect(existsSync(join(root, 'modules/notes/mail'))).toBe(false);
  });

  it('refuses a name that is not PascalCase and a module that is not there', () => {
    const root = app();
    expect(run(root, ['note-shared']).code).toBe(2);
    expect(run(root, ['NoteShared'], { module: 'missing' }).lines[0]).toContain('Module "missing" does not exist');
  });

  describe('--layout', () => {
    function withUi(index: string | null, frame = true) {
      const root = app();
      mkdirSync(join(root, 'modules/ui/mail'), { recursive: true });
      if (index !== null) writeFileSync(join(root, 'modules/ui/index.ts'), index);
      if (frame) writeFileSync(join(root, 'modules/ui/mail/layout.ts'), '// frame\n');
      return root;
    }
    const files = (root: string) => existsSync(join(root, 'modules/notes/mail')) ? readdirSync(join(root, 'modules/notes/mail')) : [];

    it('imports the frame of the other module and writes no layout', () => {
      const root = withUi("export { layout } from './mail/layout.ts';\n");
      const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
      expect(code).toBe(0);
      expect(lines).toContain('✓ Created modules/notes/mail/NoteSharedMail.ts');
      expect(lines.join('\n')).not.toContain('layout.ts');
      expect(files(root)).toEqual(['NoteSharedMail.ts']);
      expect(readFileSync(join(root, 'modules/notes/mail/NoteSharedMail.ts'), 'utf8')).toContain("import { layout } from '#modules/ui';");
      expect(readFileSync(join(root, 'modules/ui/index.ts'), 'utf8')).toBe("export { layout } from './mail/layout.ts';\n");
    });

    it.each(["export function layout() {}", 'export const layout = 1;', "export { frame as layout };\nconst frame = 1;", "export { x as 'layout' } from './x.ts';"])('sees %s as the export', (index) => {
      const { lines } = run(withUi(index), ['NoteShared'], { module: 'notes', layout: 'ui' });
      expect(lines.join('\n')).not.toContain('does not export');
    });

    it('writes the mail and prints the missing export line, leaving the other entry as it was', () => {
      for (const index of ["export const other = 1;\n", "export * from './mail/layout.ts';\n", null]) {
        const root = withUi(index);
        const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
        expect(code).toBe(0);
        expect(files(root)).toEqual(['NoteSharedMail.ts']);
        expect(lines).toContain('! modules/ui/index.ts does not export layout. Add it yourself:');
        expect(lines).toContain("  export { layout } from './mail/layout.ts';");
        if (index !== null) expect(readFileSync(join(root, 'modules/ui/index.ts'), 'utf8')).toBe(index);
      }
    });

    it.each(['export type layout = 1;', 'export interface layout {}', 'export type { layout };', 'export { type layout };', "export type { layout } from './mail/layout.ts';"])(
      'treats the type-only %s as no export',
      (index) => {
        const root = withUi(index);
        const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
        expect(code).toBe(0);
        expect(files(root)).toEqual(['NoteSharedMail.ts']);
        expect(lines).toContain('! modules/ui/index.ts does not export layout. Add it yourself:');
      },
    );

    it('counts a value export next to a type-only one of the same name', () => {
      const { lines } = run(withUi('export type { layout };\nexport function layout() {}\n'), ['NoteShared'], { module: 'notes', layout: 'ui' });
      expect(lines.join('\n')).not.toContain('does not export');
      const mixed = run(withUi("export { type layout, layout as frame };\nexport { layout } from './mail/layout.ts';\n"), ['NoteShared'], { module: 'notes', layout: 'ui' });
      expect(mixed.lines.join('\n')).not.toContain('does not export');
    });

    it('says the entry does not parse instead of asking for an export that may be there', () => {
      const root = withUi("export { layout } from './mail/layout.ts'; export {{\n");
      const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
      expect(code).toBe(0);
      expect(files(root)).toEqual(['NoteSharedMail.ts']);
      expect(lines).toContain('! modules/ui/index.ts does not parse; check that it exports layout:');
      expect(lines.join('\n')).toContain('Send it: await mailer.send(new NoteSharedMail(');
    });

    it('stops before writing when the module has no frame', () => {
      const root = withUi("export const other = 1;\n", false);
      const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
      expect([code, lines]).toEqual([1, ['✗ Module "ui" has no frame: marmeon make:mail <Mail> --module=ui writes the frame there first.']]);
      expect(files(root)).toEqual([]);
    });

    it('stops before writing when the module does not exist', () => {
      const root = app();
      const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'nope' });
      expect(code).toBe(1);
      expect(lines[0]).toContain('Module "nope" does not exist');
      expect(files(root)).toEqual([]);
    });

    it('refuses a value that is no module name, before anything is written', () => {
      const root = withUi("export { layout } from './mail/layout.ts';\n");
      for (const layout of ['../ui', 'ui/mail', "ui'; evil()", 'ui\n', 'UI', '', '`${x}`', true]) {
        expect(run(root, ['NoteShared'], { module: 'notes', layout }).code).toBe(2);
      }
      expect(files(root)).toEqual([]);
    });

    it('behaves as without the option when it names the mail\'s own module', () => {
      const root = app();
      const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'notes' });
      expect(code).toBe(0);
      expect(lines).toContain('✓ Created modules/notes/mail/layout.ts');
      expect(readFileSync(join(root, 'modules/notes/mail/NoteSharedMail.ts'), 'utf8')).toContain("from './layout.ts'");
    });
  });
  describe('in an app with @marmeon/react', () => {
    const reactApp = (extra: Record<string, string> = { 'oxc-transform': '^0.157.0' }) =>
      app(JSON.stringify({ dependencies: { '@marmeon/mail': 'workspace:*', '@marmeon/i18n': 'workspace:*', '@marmeon/react': 'workspace:*' }, devDependencies: extra }));
    const read = (root: string, file: string) => readFileSync(join(root, 'modules', file), 'utf8');
    const files = (root: string, dir = 'notes/mail') => (existsSync(join(root, 'modules', dir)) ? readdirSync(join(root, 'modules', dir)).sort() : []);

    it('writes the class, the view and the frame as a component', () => {
      const root = reactApp();
      const { code, lines } = run(root, ['NoteShared']);
      expect(code).toBe(0);
      expect(lines).toEqual(expect.arrayContaining(['✓ Created modules/notes/mail/NoteSharedMail.ts', '✓ Created modules/notes/mail/NoteSharedView.tsx', '✓ Created modules/notes/mail/Layout.tsx']));
      expect(lines.filter((line) => line.startsWith('!'))).toEqual([]);
      expect(files(root)).toEqual(['Layout.tsx', 'NoteSharedMail.ts', 'NoteSharedView.tsx']);
      const mail = read(root, 'notes/mail/NoteSharedMail.ts');
      expect(mail).toContain("import { toMjml } from '@marmeon/react/mail';");
      expect(mail).toContain('return toMjml(NoteSharedView, { t: this.#t, name });');
      expect(mail).not.toContain('layout');
      const view = read(root, 'notes/mail/NoteSharedView.tsx');
      expect(view).toContain("import { Layout } from './Layout.tsx';");
      expect(view).toContain('<Layout t={t} preview="A message for you">');
      expect(read(root, 'notes/mail/Layout.tsx')).toContain('export function Layout({ t, preview, children }: LayoutProps)');
    });

    it('names the view after the mail, also when the name ends in Mail', () => {
      const root = reactApp();
      expect(run(root, ['WelcomeMail']).code).toBe(0);
      expect(files(root)).toContain('WelcomeView.tsx');
    });

    it('uses the Layout.tsx that is there, even with --force', () => {
      const root = reactApp();
      run(root, ['NoteShared']);
      writeFileSync(join(root, 'modules/notes/mail/Layout.tsx'), '// mine\n');
      const second = run(root, ['NoteRead'], { module: 'notes', force: true });
      expect(second.lines).toContain('Using modules/notes/mail/Layout.tsx');
      expect(read(root, 'notes/mail/Layout.tsx')).toBe('// mine\n');
    });

    it('nests the body of the view into a template layout.ts that is there', () => {
      const root = reactApp();
      mkdirSync(join(root, 'modules/notes/mail'));
      writeFileSync(join(root, 'modules/notes/mail/layout.ts'), '// mine\n');
      const { code, lines } = run(root, ['NoteShared']);
      expect(code).toBe(0);
      expect(lines).toContain('Using modules/notes/mail/layout.ts');
      expect(files(root)).toEqual(['NoteSharedMail.ts', 'NoteSharedView.tsx', 'layout.ts']);
      const mail = read(root, 'notes/mail/NoteSharedMail.ts');
      expect(mail).toContain("import { layout } from './layout.ts';");
      expect(mail).toContain('body: toMjml(NoteSharedView, { name })');
      const view = read(root, 'notes/mail/NoteSharedView.tsx');
      expect(view).not.toContain('Layout');
      expect(view).not.toContain('MjmlDocument');
    });

    it('never overwrites the mail or the view without --force, and writes neither when one is there', () => {
      const root = reactApp();
      run(root, ['NoteShared']);
      const view = join(root, 'modules/notes/mail/NoteSharedView.tsx');
      writeFileSync(view, '// mine\n');
      rmSync(join(root, 'modules/notes/mail/NoteSharedMail.ts'));
      const second = run(root, ['NoteShared']);
      expect([second.code, second.lines]).toEqual([1, ['✗ modules/notes/mail/NoteSharedView.tsx already exists (use --force to overwrite).']]);
      expect(files(root)).not.toContain('NoteSharedMail.ts');
      expect(run(root, ['NoteShared'], { module: 'notes', force: true }).code).toBe(0);
      expect(readFileSync(view, 'utf8')).toContain('export function NoteSharedView');
    });

    it('writes nothing when the guard refuses the view: a dangling link, or a hard link with --force', () => {
      const root = reactApp();
      mkdirSync(join(root, 'modules/notes/mail'));
      const view = join(root, 'modules/notes/mail/NoteSharedView.tsx');
      symlinkSync(join(root, 'nowhere.tsx'), view);
      // Without --force: existsSync sees nothing at a dangling link, so only the early link guard stops the class.
      const dangling = run(root, ['NoteShared'], { module: 'notes' });
      expect(dangling.code).toBe(1);
      expect(files(root)).toEqual(['NoteSharedView.tsx']);
      rmSync(view);
      const other = join(root, 'other.tsx');
      writeFileSync(other, '// other\n');
      linkSync(other, view);
      writeFileSync(join(root, 'modules/notes/mail/NoteSharedMail.ts'), '// mine\n');
      const hard = run(root, ['NoteShared'], { module: 'notes', force: true });
      expect(hard.code).toBe(1);
      expect(read(root, 'notes/mail/NoteSharedMail.ts')).toBe('// mine\n');
      expect(files(root)).toEqual(['NoteSharedMail.ts', 'NoteSharedView.tsx']);
    });

    it('names the frame the view uses when the module has both Layout.tsx and layout.ts', () => {
      const root = reactApp();
      mkdirSync(join(root, 'modules/notes/mail'));
      writeFileSync(join(root, 'modules/notes/mail/Layout.tsx'), '// c\n');
      writeFileSync(join(root, 'modules/notes/mail/layout.ts'), '// f\n');
      const { lines } = run(root, ['NoteShared']);
      expect(lines).toContain('Using modules/notes/mail/Layout.tsx');
      expect(read(root, 'notes/mail/NoteSharedView.tsx')).toContain("from './Layout.tsx'");
    });

    it('warns with the install command when oxc-transform is missing, and not when it is listed', () => {
      const without = run(reactApp({}), ['NoteShared']);
      expect(without.code).toBe(0);
      expect(without.lines).toContain('! Mail views are compiled by oxc-transform, which this app does not list: pnpm add -D oxc-transform');
      expect(run(reactApp(), ['NoteShared']).lines.join('\n')).not.toContain('oxc-transform');
    });

    it('writes the template form with --template', () => {
      const root = reactApp();
      const { code, lines } = run(root, ['NoteShared'], { module: 'notes', template: true });
      expect(code).toBe(0);
      expect(files(root)).toEqual(['NoteSharedMail.ts', 'layout.ts']);
      expect(lines.join('\n')).not.toContain('oxc-transform');
      expect(read(root, 'notes/mail/NoteSharedMail.ts')).toContain('return layout(t, {');
    });

    it('writes a mail with html`…` and no frame with --html', () => {
      for (const root of [reactApp(), app()]) {
        const { code, lines } = run(root, ['NoteShared'], { module: 'notes', html: true });
        expect(code).toBe(0);
        expect(files(root)).toEqual(['NoteSharedMail.ts']);
        expect(lines.join('\n')).not.toContain('oxc-transform');
        const mail = read(root, 'notes/mail/NoteSharedMail.ts');
        expect(mail).toContain("import { html, type Address, type Mailable, type MailPreviewContext } from '@marmeon/mail';");
        expect(mail).toContain('return html`');
        expect(mail).toContain('Outlook');
      }
    });

    it('refuses --html with --layout or --template, before anything is written', () => {
      const root = reactApp();
      for (const options of [{ layout: 'ui' }, { layout: 'notes' }, { template: true }]) {
        const { code, lines } = run(root, ['NoteShared'], { module: 'notes', html: true, ...options });
        expect([code, lines]).toEqual([2, ['✗ --html writes a mail without a frame: it cannot be combined with --layout or --template']]);
      }
      expect(files(root)).toEqual([]);
    });

    describe('--layout', () => {
      function withUi(frame: 'Layout.tsx' | 'layout.ts' | null, index: string | null) {
        const root = reactApp();
        mkdirSync(join(root, 'modules/ui/mail'), { recursive: true });
        if (index !== null) writeFileSync(join(root, 'modules/ui/index.ts'), index);
        if (frame !== null) writeFileSync(join(root, 'modules/ui/mail', frame), '// frame\n');
        return root;
      }

      it('imports the Layout component through the entry of the other module', () => {
        const root = withUi('Layout.tsx', "export { Layout } from './mail/Layout.tsx';\n");
        const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
        expect(code).toBe(0);
        expect(lines.join('\n')).not.toContain('! ');
        expect(files(root)).toEqual(['NoteSharedMail.ts', 'NoteSharedView.tsx']);
        expect(read(root, 'notes/mail/NoteSharedView.tsx')).toContain("import { Layout } from '#modules/ui';");
      });

      it('prints the Layout export to add when the entry has none', () => {
        const root = withUi('Layout.tsx', "export const other = 1;\n");
        const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
        expect(code).toBe(0);
        expect(lines).toContain('! modules/ui/index.ts does not export Layout. Add it yourself:');
        expect(lines).toContain("  export { Layout } from './mail/Layout.tsx';");
      });

      it('takes the template layout of the other module as the frame of the class', () => {
        const root = withUi('layout.ts', "export { layout } from './mail/layout.ts';\n");
        const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
        expect(code).toBe(0);
        expect(lines.join('\n')).not.toContain('! ');
        expect(read(root, 'notes/mail/NoteSharedMail.ts')).toContain("import { layout } from '#modules/ui';");
        expect(read(root, 'notes/mail/NoteSharedView.tsx')).not.toContain('Layout');
      });

      it('decides by the files of the other module before its exports: a page Layout is no frame', () => {
        const root = withUi('layout.ts', "export { layout } from './mail/layout.ts';\nexport { Layout } from './views/Layout.tsx';\n");
        const { code } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
        expect(code).toBe(0);
        expect(read(root, 'notes/mail/NoteSharedMail.ts')).toContain("import { layout } from '#modules/ui';");
        expect(read(root, 'notes/mail/NoteSharedView.tsx')).not.toContain('Layout');
      });

      it('stops before writing when the module has neither frame', () => {
        const root = withUi(null, "export const other = 1;\n");
        const { code, lines } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui' });
        expect([code, lines]).toEqual([1, ['✗ Module "ui" has no frame: marmeon make:mail <Mail> --module=ui writes the frame there first.']]);
        expect(files(root)).toEqual([]);
      });

      it('does not take a Layout.tsx as the frame of a template mail', () => {
        const root = withUi('Layout.tsx', "export { Layout } from './mail/Layout.tsx';\n");
        const { code } = run(root, ['NoteShared'], { module: 'notes', layout: 'ui', template: true });
        expect(code).toBe(1);
        expect(files(root)).toEqual([]);
      });
    });
  });
});
