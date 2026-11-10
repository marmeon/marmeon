import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { declaredServerModules, SERVER_MODULES } from './server-modules.ts';

/** An app root whose package.json holds `content` (a string as is, anything else as JSON); none when `content` is `undefined`. */
function app(content?: unknown): string {
  const root = tempDir('marmeon-server-modules-');
  if (content !== undefined) writeFileSync(join(root, 'package.json'), typeof content === 'string' ? content : JSON.stringify(content));
  return root;
}

const declaring = (serverModules: unknown): string => app({ name: 'x', marmeon: { serverModules } });

function messageOf(root: string): string {
  try {
    declaredServerModules(root);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('declaredServerModules did not throw');
}

describe('SERVER_MODULES', () => {
  it('lists the conventions, every pattern relative to the app root', () => {
    expect(SERVER_MODULES).toContainEqual({ pattern: 'modules/*/jobs/**', what: 'a job' });
    expect(SERVER_MODULES.every((module) => !module.pattern.startsWith('/'))).toBe(true);
  });
});

describe('declaredServerModules — the server folders in package.json', () => {
  it('declares nothing without a package.json, without "marmeon" and without "serverModules"', () => {
    expect(declaredServerModules(app())).toEqual([]);
    expect(declaredServerModules(app({ name: 'x' }))).toEqual([]);
    expect(declaredServerModules(app({ name: 'x', marmeon: {} }))).toEqual([]);
    expect(declaredServerModules(app({ name: 'x', marmeon: { providers: ['A'] } }))).toEqual([]);
  });

  it('returns the list as written, frozen', () => {
    const list = ['modules/billing/invoices/**', '!modules/notes/jobs/labels.ts', 'modules/*/services/*.ts'];
    const declared = declaredServerModules(declaring(list));
    expect(declared).toEqual(list);
    expect(Object.isFrozen(declared)).toBe(true);
    expect(declaredServerModules(declaring([]))).toEqual([]);
  });

  it('refuses a package.json that cannot be read', (context) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return context.skip();
    const root = app({ name: 'x' });
    chmodSync(join(root, 'package.json'), 0o000);
    expect(messageOf(root)).toMatch(/^\[marmeon:H14\] package\.json: cannot be read \(EACCES\)/);
    const directory = tempDir('marmeon-server-modules-');
    mkdirSync(join(directory, 'package.json'));
    expect(messageOf(directory)).toMatch(/^\[marmeon:H14\] package\.json: cannot be read \(EISDIR\)/);
  });

  it('refuses invalid JSON without quoting the file', () => {
    const message = messageOf(app('{ "marmeon": nonsense-text'));
    expect(message).toMatch(/^\[marmeon:H14\] package\.json: is not valid JSON/);
    expect(message).not.toContain('nonsense-text');
    expect(messageOf(app('[]'))).toContain('is not a JSON object');
  });

  it('refuses a "marmeon" that is no object', () => {
    for (const value of [[], null, 'modules/**', 7]) {
      expect(messageOf(app({ name: 'x', marmeon: value })), JSON.stringify(value)).toMatch(/^\[marmeon:H14\] package\.json: "marmeon" is not an object/);
    }
  });

  it('refuses a misspelt key and names it', () => {
    const message = messageOf(app({ name: 'x', marmeon: { serverModule: ['modules/x/**'] } }));
    expect(message).toMatch(/^\[marmeon:H14\] /);
    expect(message).toContain('unknown key "serverModule"');
  });

  it('refuses "serverModules" that is no list, and an entry that is no string', () => {
    expect(messageOf(declaring('modules/x/**'))).toContain('"serverModules" is not a list of globs');
    expect(messageOf(declaring({ 0: 'modules/x/**' }))).toContain('is not a list of globs');
    expect(messageOf(declaring(['modules/x/**', 5]))).toContain('entry 1 is not a string');
  });

  it.each([
    ['', 'is empty'],
    ['!', 'is empty'],
    ['/modules/x/**', 'starts with "/"'],
    ['modules\\x\\**', 'uses "\\"'],
    ['modules/../x/**', '"." or ".." segment'],
    ['modules/./x/**', '"." or ".." segment'],
    ['modules//x/**', 'empty segment'],
    ['modules/x/', 'empty segment'],
    ['modules/{a,b}/**', 'uses braces — list each alternative as its own entry'],
    ['modules/a!b/**', '"!" after its start'],
    ['!!modules/x/**', '"!" after its start'],
    ['modules/billing/invoices', 'write "modules/billing/invoices/**"'],
    ['!modules/billing/invoices', 'write "!modules/billing/invoices/**"'],
    ['modules/+(a|b)/**', 'extglob'],
    ['modules/@(a)/**', 'extglob'],
    ['modules/a|b/**', 'extglob'],
    [' modules/x/**', 'starts or ends with a space'],
    ['modules/x/** ', 'starts or ends with a space'],
    ['#modules/billing/**', 'starts with "#"'],
  ])('refuses the entry %j', (entry, reason) => {
    const message = messageOf(declaring(['modules/ok/**', entry]));
    expect(message).toMatch(/^\[marmeon:H14\] package\.json: "marmeon"\."serverModules" entry 1 /);
    expect(message).toContain(reason);
    expect(message).toContain('docs/vite.md#server-folders-of-your-own');
  });

  it('refuses "__proto__" as a key of "marmeon", as written in the JSON', () => {
    const message = messageOf(app('{"name":"x","marmeon":{"__proto__":{"serverModules":["x/**"]}}}'));
    expect(message).toContain('unknown key "__proto__"');
  });

  it('does not read a "serverModules" from Object.prototype', () => {
    Object.defineProperty(Object.prototype, 'serverModules', { value: ['polluted/**'], configurable: true });
    try {
      expect(declaredServerModules(app({ name: 'x', marmeon: {} }))).toEqual([]);
    } finally {
      delete (Object.prototype as Record<string, unknown>).serverModules;
    }
  });
});
