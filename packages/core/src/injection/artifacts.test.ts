import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { injectConstructorDependencies } from './analyze.ts';
import { computeInjectionArtifacts, INJECTIONS_FILE, PrecomputedInjections, writeInjectionArtifacts } from './artifacts.ts';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

const decode = (source: Uint8Array) => new TextDecoder().decode(source);
const webApp = fileURLToPath(new URL('../../../../apps/web-app', import.meta.url));

const controller = [
  "import { UserRepository } from './UserRepository.ts';",
  '',
  'export class ShowUserController {',
  '  constructor(users: UserRepository) {}',
  '}',
].join('\n');

describe('injection artifacts', () => {
  let root: string;
  const write = (path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-injections-'));
    write('package.json', JSON.stringify({ type: 'module', marmeon: { browser: ['client/**'] } }));
  });

  it('refuses a .marmeon that links out of the app, and writes nothing there', () => {
    write('modules/users/ShowUserController.ts', controller);
    const outside = tempDir('marmeon-injections-outside-');
    symlinkSync(outside, join(root, '.marmeon'), 'dir');
    expect(() => writeInjectionArtifacts({ root })).toThrow(/^\.marmeon leads out of the app.*Nothing was written\.$/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to read a current injections file through a .marmeon that links out of the app', () => {
    write('modules/users/ShowUserController.ts', controller);
    writeInjectionArtifacts({ root });
    const outside = tempDir('marmeon-injections-read-outside-');
    writeFileSync(join(outside, 'injections.json'), readFileSync(join(root, INJECTIONS_FILE)));
    rmSync(join(root, '.marmeon'), { recursive: true });
    symlinkSync(outside, join(root, '.marmeon'), 'dir');
    expect(() => PrecomputedInjections.load(root)).toThrow(/^\.marmeon leads out of the app, so \.marmeon\/injections\.json was not read\./);
  });

  it('refuses an injections file that is a link to an outside file, and reads one that stays inside the app', () => {
    write('modules/users/ShowUserController.ts', controller);
    writeInjectionArtifacts({ root });
    const file = join(root, INJECTIONS_FILE);
    const outside = tempDir('marmeon-injections-file-outside-');
    writeFileSync(join(outside, 'injections.json'), readFileSync(file));
    rmSync(file);
    symlinkSync(join(outside, 'injections.json'), file);
    expect(() => PrecomputedInjections.load(root)).toThrow(/^\.marmeon\/injections\.json leads out of the app, so .* was not read\./);
    rmSync(file);
    write('copy.json', '{ "format": 1, "files": {} }');
    symlinkSync(join(root, 'copy.json'), file);
    expect(() => PrecomputedInjections.load(root)).not.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)('treats a .marmeon that cannot be searched as no file, not as an error', () => {
    mkdirSync(join(root, '.marmeon'));
    chmodSync(join(root, '.marmeon'), 0);
    onTestFinished(() => chmodSync(join(root, '.marmeon'), 0o755));
    expect(() => PrecomputedInjections.load(root)).not.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)('refuses a .marmeon that links to an outside directory that cannot be searched', () => {
    const outside = tempDir('marmeon-injections-locked-outside-');
    writeFileSync(join(outside, 'injections.json'), '{ "format": 1, "files": {} }');
    symlinkSync(outside, join(root, '.marmeon'), 'dir');
    chmodSync(outside, 0);
    onTestFinished(() => chmodSync(outside, 0o755));
    expect(() => PrecomputedInjections.load(root)).toThrow(/^\.marmeon leads out of the app, so \.marmeon\/injections\.json was not read\./);
  });

  it('covers the modules of the app that mention a constructor — no tests, browser sources, node_modules, dist or storage', () => {
    write('modules/users/ShowUserController.ts', controller);
    write('modules/users/Plain.ts', 'export class Plain {}\n');
    write('modules/users/NoParameters.ts', 'export class NoParameters { constructor() {} }\n');
    for (const path of ['modules/users/users.test.ts', 'client/Widget.ts', 'node_modules/x/X.ts', 'dist/server/X.ts', 'storage/X.ts', '.cache/X.ts', 'modules/users/types.d.ts']) {
      write(path, controller);
    }

    const { path, modules, classes } = writeInjectionArtifacts({ root });

    expect(path).toBe(join(root, INJECTIONS_FILE));
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(file.files).sort()).toEqual(['modules/users/NoParameters.ts', 'modules/users/ShowUserController.ts']);
    expect(file.files['modules/users/ShowUserController.ts'].insert).toEqual([[controller.indexOf('{', controller.indexOf('class')) + 1, ' static inject = [UserRepository];']]);
    // Derived, nothing to insert: listed, so a start does not count it as stale.
    expect(file.files['modules/users/NoParameters.ts'].insert).toEqual([]);
    expect({ modules, classes }).toEqual({ modules: 2, classes: 1 });
  });

  it('is the analysis of the load hook — line for line, for every module of the web app', () => {
    // The web app's artifacts, read back from another root: the start's path (hash check, insertions) against the hook's analysis.
    const artifacts = computeInjectionArtifacts(webApp);
    write(INJECTIONS_FILE, JSON.stringify(artifacts));
    const precomputed = PrecomputedInjections.load(root);
    const names = Object.keys(artifacts.files);
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      const source = readFileSync(join(webApp, name));
      const transformed = precomputed.transform(join(root, name), source, decode);
      expect(transformed, name).toBe(injectConstructorDependencies(source.toString('utf8'), name));
      expect(transformed.split('\n').length, name).toBe(source.toString('utf8').split('\n').length);
    }
    expect(precomputed.stale).toEqual([]);
  });

  it('applies the precomputed lists while a module is unchanged — and never trusts them once it changed', () => {
    write('modules/users/ShowUserController.ts', controller);
    writeInjectionArtifacts({ root });
    // Make the artifact recognisable: an unchanged module gets exactly what the file says, without analysis.
    const path = join(root, INJECTIONS_FILE);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.files['modules/users/ShowUserController.ts'].insert[0][1] = ' static inject = [FromTheBuild];';
    writeFileSync(path, JSON.stringify(file));

    const precomputed = PrecomputedInjections.load(root);
    const module = join(root, 'modules/users/ShowUserController.ts');
    expect(precomputed.transform(module, Buffer.from(controller), decode)).toContain('static inject = [FromTheBuild];');
    expect(precomputed.stale).toEqual([]);
    expect(precomputed.warning()).toBeUndefined();

    const changed = controller.replace('(users: UserRepository)', '(users: UserRepository, mailer: UserRepository)');
    expect(precomputed.transform(module, Buffer.from(changed), decode)).toBe(injectConstructorDependencies(changed, 'modules/users/ShowUserController.ts'));
    expect(precomputed.stale).toEqual(['modules/users/ShowUserController.ts']);
    expect(precomputed.warning()).toBe(
      'Build artifacts are stale (1 file: modules/users/ShowUserController.ts): it changed since marmeon build, so it was analysed at start (injection lists with oxc-parser, mail views with oxc-transform) — run marmeon build again.',
    );
  });

  describe('island controllers', () => {
    const island = 'export class ShowPanelController {\n  handle() {\n    return this.island(Panel, {});\n  }\n}\n';
    const marked = 'marmeon.island-controller';

    it('lists an island controller without a constructor, and a precomputed start marks it without analysis', () => {
      write('modules/panel/ShowPanelController.ts', island);
      write('modules/panel/Other.ts', 'export const x = 1;\n');
      const { files } = computeInjectionArtifacts(root);
      expect(Object.keys(files)).toEqual(['modules/panel/ShowPanelController.ts']);
      expect(files['modules/panel/ShowPanelController.ts']!.insert[0]![1]).toContain(marked);

      writeInjectionArtifacts({ root });
      const precomputed = PrecomputedInjections.load(root);
      const module = join(root, 'modules/panel/ShowPanelController.ts');
      expect(precomputed.transform(module, Buffer.from(island), decode)).toContain(marked);
      expect(precomputed.stale).toEqual([]);
    });

    it('lists an island controller whose call has type arguments and which has no constructor', () => {
      write('modules/panel/Typed.ts', "export class Typed {\n  handle() {\n    return this.island<'x', {}>(Panel, {});\n  }\n}\n");
      expect(computeInjectionArtifacts(root).files['modules/panel/Typed.ts']!.insert[0]![1]).toContain(marked);
    });

    it('writes format 2, and a format 1 file counts as missing: the controller is analysed and marked', () => {
      write('modules/panel/ShowPanelController.ts', island);
      writeInjectionArtifacts({ root });
      const path = join(root, INJECTIONS_FILE);
      const file = JSON.parse(readFileSync(path, 'utf8'));
      expect(file.format).toBe(2);

      writeFileSync(path, JSON.stringify({ ...file, format: 1, files: { 'modules/panel/ShowPanelController.ts': { ...file.files['modules/panel/ShowPanelController.ts'], insert: [] } } }));
      const precomputed = PrecomputedInjections.load(root);
      const module = join(root, 'modules/panel/ShowPanelController.ts');
      expect(precomputed.transform(module, Buffer.from(island), decode)).toContain(marked);
      expect(precomputed.stale).toEqual(['modules/panel/ShowPanelController.ts']);
      expect(precomputed.warning()).toMatch(/Build artifacts are missing/);
    });

    it('marks a changed island controller that has no constructor when the file lists it', () => {
      write('modules/panel/ShowPanelController.ts', island);
      writeInjectionArtifacts({ root });
      const precomputed = PrecomputedInjections.load(root);
      const changed = `${island}// edited\n`;
      expect(precomputed.transform(join(root, 'modules/panel/ShowPanelController.ts'), Buffer.from(changed), decode)).toContain(marked);
      expect(precomputed.stale).toEqual(['modules/panel/ShowPanelController.ts']);
    });
  });

  it('analyses a module the file does not know, a missing file and modules outside the app — counting only the app', () => {
    write('modules/users/ShowUserController.ts', controller);
    writeInjectionArtifacts({ root });
    const precomputed = PrecomputedInjections.load(root);

    const added = join(root, 'modules/users/Added.ts');
    expect(precomputed.transform(added, controller, decode)).toContain('static inject = [UserRepository];');
    // Nothing to derive without `constructor` — not stale either.
    expect(precomputed.transform(join(root, 'modules/users/Helper.ts'), 'export const x = 1;\n', decode)).toBe('export const x = 1;\n');
    // A workspace package's sources (the monorepo's source condition): analysed, not the app's artifact.
    expect(precomputed.transform('/elsewhere/packages/x/src/X.ts', controller, decode)).toContain('static inject = [UserRepository];');
    expect(precomputed.stale).toEqual(['modules/users/Added.ts']);

    rmSync(join(root, INJECTIONS_FILE));
    const missing = PrecomputedInjections.load(root);
    expect(missing.transform(join(root, 'modules/users/ShowUserController.ts'), controller, decode)).toContain('static inject = [UserRepository];');
    expect(missing.warning()).toBe(
      'Build artifacts are missing (.marmeon/injections.json): 1 file (modules/users/ShowUserController.ts) was analysed at start (injection lists with oxc-parser, mail views with oxc-transform) — run marmeon build before starting.',
    );
  });

  it('counts a listed module that lost its constructor as stale — and inserts nothing into it', () => {
    write('modules/users/ShowUserController.ts', controller);
    writeInjectionArtifacts({ root });
    const precomputed = PrecomputedInjections.load(root);
    const now = 'export class ShowUserController {}\n';
    expect(precomputed.transform(join(root, 'modules/users/ShowUserController.ts'), now, decode)).toBe(now);
    expect(precomputed.stale).toEqual(['modules/users/ShowUserController.ts']);
  });
});
