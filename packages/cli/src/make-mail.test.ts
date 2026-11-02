import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
});
