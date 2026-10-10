import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
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
      'Build artifacts are stale (1 file: modules/users/ShowUserController.ts): they changed since marmeon build, so their injection lists were derived at start, with oxc-parser — run marmeon build again.',
    );
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
      'Build artifacts are missing (.marmeon/injections.json): the injection lists of 1 file (modules/users/ShowUserController.ts) were derived at start, with oxc-parser — run marmeon build before starting.',
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
