import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from './environment.ts';
import { MAIL_VIEWS_FILE, PrecomputedMailViews, writeMailViewArtifacts } from './mail-view-artifacts.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const register = fileURLToPath(new URL('./register.ts', import.meta.url));
const artifacts = fileURLToPath(new URL('./injection/artifacts.ts', import.meta.url));
const VIEW = 'modules/x/mail/View.tsx';

describe('mail views precompiled by marmeon build', () => {
  let root: string;
  const write = (path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  /** A start under `NODE_ENV=production` that imports the view; `hide` makes oxc-transform unresolvable, as in a production image. */
  const start = ({ hide = false, env = 'production', view = VIEW }: { hide?: boolean; env?: string; view?: string } = {}) => {
    write(
      'hide.mjs',
      "import { registerHooks } from 'node:module';\nregisterHooks({ resolve(specifier, context, next) { if (specifier === 'oxc-transform') throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); return next(specifier, context); } });\n",
    );
    write('main.ts', `try { const view = await import(${JSON.stringify(join(root, view))}); console.log(JSON.stringify(view.default)); } catch (error) { console.log('ERROR ' + error.name + ': ' + error.message); }\nconsole.log('WARNING ' + ((await import(${JSON.stringify(artifacts)})).takeInjectionWarning() ?? 'none'));`);
    const args = ['--import', register, ...(hide ? ['--import', join(root, 'hide.mjs')] : []), join(root, 'main.ts')];
    const { stdout, stderr, signal } = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: env } });
    expect(signal, 'the child timed out').toBeNull();
    const lines = stdout.trim().split('\n');
    const warning = lines.pop()?.replace(/^WARNING /, '');
    return { stdout: lines.join('\n'), stderr, warning };
  };
  const artifact = () => JSON.parse(readFileSync(join(root, MAIL_VIEWS_FILE), 'utf8')) as { format: number; files: Record<string, { sha256: string; code: string }> };

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mail-view-artifacts-'));
    write('package.json', JSON.stringify({ type: 'module' }));
    write('node_modules/react/package.json', JSON.stringify({ name: 'react', type: 'module', exports: { './jsx-runtime': './jsx-runtime.js' } }));
    write('node_modules/react/jsx-runtime.js', "export const jsx = (type, props) => ({ type, props });\nexport const jsxs = jsx;\nexport const Fragment = 'fragment';\n");
    write(VIEW, 'export default <p>Hi</p>;\n');
  });

  it('writes an entry per mail view: the hash of the source and the compiled code, none for a page view', () => {
    write('modules/x/views/Page.tsx', 'export default <p />;\n');
    expect(writeMailViewArtifacts({ root }).views).toBe(1);
    const { format, files } = artifact();
    expect(format).toBe(1);
    expect(Object.keys(files)).toEqual([VIEW]);
    expect(files[VIEW]!.code).toContain('react/jsx-runtime');
    expect(files[VIEW]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The map names the source beside the script (no folder twice, no build-machine path).
    const map = JSON.parse(Buffer.from(/sourceMappingURL=data:application\/json;base64,(\S+)/.exec(files[VIEW]!.code)![1]!, 'base64').toString()) as { sources: string[] };
    expect(map.sources).toEqual(['View.tsx']);
    expect(files[VIEW]!.code).not.toContain(root);
  });

  it('writes no file for an app without mail views, and removes one an earlier build left', () => {
    writeMailViewArtifacts({ root });
    rmSync(join(root, VIEW));
    expect(writeMailViewArtifacts({ root }).views).toBe(0);
    expect(existsSync(join(root, MAIL_VIEWS_FILE))).toBe(false);
  });

  it('starts in production and renders without ever loading oxc-transform', () => {
    writeMailViewArtifacts({ root });
    const { stdout, warning } = start({ hide: true });
    expect(stdout).toBe(JSON.stringify({ type: 'p', props: { children: 'Hi' } }));
    expect(warning).toBe('none');
  });

  it('compiles a view that changed after the build when oxc-transform is there, and counts it as stale', () => {
    writeMailViewArtifacts({ root });
    write(VIEW, 'export default <p>Changed</p>;\n');
    const { stdout, warning } = start();
    expect(stdout).toBe(JSON.stringify({ type: 'p', props: { children: 'Changed' } }));
    expect(warning).toContain(`1 file (${VIEW}) was analysed at start`);
  });

  it('refuses a view that changed after the build when oxc-transform is missing — never loads it as written', () => {
    writeMailViewArtifacts({ root });
    write(VIEW, "console.log('RAN'); export default <p>Changed</p>;\n");
    const { stdout } = start({ hide: true });
    expect(stdout).toBe(`ERROR ConfigError: ${VIEW} changed since marmeon build (or is not part of it) — run marmeon build.`);
    expect(stdout).not.toContain('RAN');
  });

  it('refuses a view the build did not know when oxc-transform is missing', () => {
    writeMailViewArtifacts({ root });
    write('modules/x/mail/Other.tsx', 'export default <p />;\n');
    const { stdout } = start({ hide: true, view: 'modules/x/mail/Other.tsx' });
    expect(stdout).toContain('ERROR ConfigError: modules/x/mail/Other.tsx changed since marmeon build');
  });

  it('serves an entry only for the file the guard accepted: an entry for a page view is never used', () => {
    write('modules/x/views/Page.tsx', "console.log('RAN'); export default <p />;\n");
    writeMailViewArtifacts({ root });
    const built = artifact();
    const forged = { ...built, files: { ...built.files, 'modules/x/views/Page.tsx': { sha256: built.files[VIEW]!.sha256, code: "console.log('FORGED'); export default 1;" } } };
    write(MAIL_VIEWS_FILE, JSON.stringify(forged));
    write('main.ts', `try { await import(${JSON.stringify(join(root, 'modules/x/views/Page.tsx'))}); } catch (error) { console.log('ERROR ' + error.message); }`);
    const { stdout } = spawnSync(process.execPath, ['--import', register, join(root, 'main.ts')], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production' } });
    expect(stdout).toContain('is TSX outside modules');
    expect(stdout).not.toContain('FORGED');
  });

  it('serves the entry of the real path for a link inside the mail folder, not for the name of the link', () => {
    write('modules/x/mail/Real.tsx', "export default <b>Real</b>;\n");
    symlinkSync(join(root, 'modules/x/mail/Real.tsx'), join(root, 'modules/x/mail/Alias.tsx'));
    writeMailViewArtifacts({ root });
    expect(Object.keys(artifact().files).sort()).toEqual(['modules/x/mail/Real.tsx', VIEW]);
    const built = artifact();
    built.files['modules/x/mail/Alias.tsx'] = { sha256: built.files['modules/x/mail/Real.tsx']!.sha256, code: "console.log('ALIAS'); export default 1;" };
    write(MAIL_VIEWS_FILE, JSON.stringify(built));
    write('main.ts', `console.log(JSON.stringify((await import(${JSON.stringify(join(root, 'modules/x/mail/Alias.tsx'))})).default));`);
    const { stdout } = spawnSync(process.execPath, ['--preserve-symlinks', '--import', register, join(root, 'main.ts')], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production' } });
    expect(stdout).not.toContain('ALIAS');
    expect(stdout).toContain('"Real"');
  });

  it('does not serve an entry compiled with another jsxImportSource: the start compiles again, or refuses without oxc-transform', () => {
    writeMailViewArtifacts({ root });
    write('node_modules/preact/package.json', JSON.stringify({ name: 'preact', type: 'module', exports: { './jsx-runtime': './jsx-runtime.js' } }));
    write('node_modules/preact/jsx-runtime.js', "export const jsx = (type, props) => ({ preact: true, type, props });\nexport const jsxs = jsx;\n");
    write('tsconfig.json', JSON.stringify({ compilerOptions: { jsxImportSource: 'preact' } }));
    expect(start().stdout).toContain('"preact":true');
    expect(start({ hide: true }).stdout).toContain(`ERROR ConfigError: ${VIEW} changed since marmeon build`);
  });

  it('keeps development unchanged: the artifact is not read, the source is compiled', () => {
    writeMailViewArtifacts({ root });
    write(MAIL_VIEWS_FILE, 'not json');
    write(VIEW, 'export default <p>Dev</p>;\n');
    expect(start({ env: 'development' }).stdout).toBe(JSON.stringify({ type: 'p', props: { children: 'Dev' } }));
  });

  describe('fails closed on an artifact it cannot trust', () => {
    const entry = { sha256: 'a'.repeat(64), code: 'export default 1;' };
    for (const [name, content] of Object.entries({
      'not JSON': '{ nope',
      'another format': JSON.stringify({ format: 2, jsxImportSource: 'react', files: {} }),
      'files as an array': JSON.stringify({ format: 1, jsxImportSource: 'react', files: [] }),
      'null': 'null',
      'an entry without code': JSON.stringify({ format: 1, jsxImportSource: 'react', files: { [VIEW]: { sha256: entry.sha256 } } }),
      'an entry that is no object': JSON.stringify({ format: 1, jsxImportSource: 'react', files: { [VIEW]: 'export default 1;' } }),
      'a hash that is no string': JSON.stringify({ format: 1, jsxImportSource: 'react', files: { [VIEW]: { ...entry, sha256: 1 } } }),
    })) {
      it(`throws a ConfigError for ${name}`, () => {
        write(MAIL_VIEWS_FILE, content);
        expect(() => PrecomputedMailViews.load(root)).toThrow(ConfigError);
        const { stdout, stderr } = start();
        expect(stdout + stderr).toContain('ConfigError');
        expect(stdout + stderr).not.toContain('"type":"p"');
      });
    }

    it('throws a ConfigError for a file without its jsxImportSource', () => {
      write(MAIL_VIEWS_FILE, JSON.stringify({ format: 1, files: {} }));
      expect(() => PrecomputedMailViews.load(root)).toThrow(ConfigError);
    });

    it('treats no file as no entries', () => {
      expect(() => PrecomputedMailViews.load(root)).not.toThrow();
      expect(PrecomputedMailViews.load(root).code(VIEW, Buffer.from('x'), 'react')).toBeUndefined();
    });

    it('ignores an entry named like an Object prototype member', () => {
      write(MAIL_VIEWS_FILE, JSON.stringify({ format: 1, jsxImportSource: 'react', files: {} }));
      const views = PrecomputedMailViews.load(root);
      expect(views.code('constructor', Buffer.from('x'), 'react')).toBeUndefined();
      expect(views.code('__proto__', Buffer.from('x'), 'react')).toBeUndefined();
    });

    it('refuses a .marmeon that is a link out of the app, for the build and for the start', () => {
      const outside = realpathSync(tempDir('marmeon-mail-view-artifacts-outside-'));
      writeFileSync(join(outside, 'mail-views.json'), JSON.stringify({ format: 1, jsxImportSource: 'react', files: { [VIEW]: { sha256: entry.sha256, code: "console.log('OUTSIDE')" } } }));
      symlinkSync(outside, join(root, '.marmeon'), 'dir');
      expect(() => PrecomputedMailViews.load(root)).toThrow(ConfigError);
      expect(() => writeMailViewArtifacts({ root })).toThrow(ConfigError);
      expect(start().stdout).not.toContain('OUTSIDE');
      expect(readFileSync(join(outside, 'mail-views.json'), 'utf8')).toContain('OUTSIDE');
    });
  });

  it('serves the code only for the bytes it was built from', () => {
    writeMailViewArtifacts({ root });
    const views = PrecomputedMailViews.load(root);
    expect(views.code(VIEW, readFileSync(join(root, VIEW)), 'react')).toBe(artifact().files[VIEW]!.code);
    expect(views.code(VIEW, Buffer.from('export default <p>Other</p>;\n'), 'react')).toBeUndefined();
  });
});
