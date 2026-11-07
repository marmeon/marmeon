import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { Output } from './output.ts';

afterEach(() => vi.restoreAllMocks());

describe('marmeon build and the mail views of an app', () => {
  it('compiles them into .marmeon/mail-views.json before anything else can fail', async () => {
    const { BuildCommand } = await import('./commands/build.ts');
    const root = realpathSync(tempDir('marmeon-build-mail-views-'));
    for (const [path, source] of Object.entries({ 'bootstrap/app.ts': '', 'modules/x/mail/View.tsx': 'export default <p>Hi</p>;\n', 'modules/x/views/Page.tsx': 'export default <p />;\n' })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (out.push(String(text)), true));
    // The build stops later (no Vite here); the artifact is written first.
    await new BuildCommand().handle({ args: [], options: { 'no-typecheck': true }, output: new Output(), root, spawn: async () => 0 } as never);
    const file = JSON.parse(readFileSync(join(root, '.marmeon/mail-views.json'), 'utf8')) as { files: Record<string, { code: string }> };
    expect(Object.keys(file.files)).toEqual(['modules/x/mail/View.tsx']);
    expect(file.files['modules/x/mail/View.tsx']!.code).toContain('jsx');
    expect(out.join('')).toContain('Compiled 1 mail view → .marmeon/mail-views.json');
  });

  it('writes no file for an app without mail views', async () => {
    const { BuildCommand } = await import('./commands/build.ts');
    const root = realpathSync(tempDir('marmeon-build-mail-views-'));
    mkdirSync(join(root, 'bootstrap'), { recursive: true });
    writeFileSync(join(root, 'bootstrap/app.ts'), '');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await new BuildCommand().handle({ args: [], options: { 'no-typecheck': true }, output: new Output(), root, spawn: async () => 0 } as never);
    expect(existsSync(join(root, '.marmeon/mail-views.json'))).toBe(false);
  });
});

describe('marmeon build without oxc-transform', () => {
  it('stops with the install command when there are mail views, and writes no artifact', () => {
    const root = realpathSync(tempDir('marmeon-build-mail-views-'));
    mkdirSync(join(root, 'modules/x/mail'), { recursive: true });
    writeFileSync(join(root, 'modules/x/mail/View.tsx'), 'export default <p />;\n');
    writeFileSync(
      join(root, 'hide.mjs'),
      "import { registerHooks } from 'node:module';\nregisterHooks({ resolve(specifier, context, next) { if (specifier === 'oxc-transform') throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); return next(specifier, context); } });\n",
    );
    const internal = fileURLToPath(new URL('../../core/src/internal.ts', import.meta.url));
    writeFileSync(join(root, 'run.ts'), `import { writeMailViewArtifacts } from ${JSON.stringify(internal)};\ntry { writeMailViewArtifacts({ root: ${JSON.stringify(root)} }); console.log('WRITTEN'); } catch (error) { console.log(error.name + ': ' + error.message); }\n`);
    const { stdout } = spawnSync(process.execPath, ['--import', join(root, 'hide.mjs'), join(root, 'run.ts')], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' } });
    expect(stdout).toContain('ConfigError: Mail views are TSX and need oxc-transform to be compiled. Install it: pnpm add -D "oxc-transform@');
    expect(stdout).not.toContain('WRITTEN');
    expect(existsSync(join(root, '.marmeon/mail-views.json'))).toBe(false);
  });
});
