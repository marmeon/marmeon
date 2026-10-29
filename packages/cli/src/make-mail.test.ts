import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
});
