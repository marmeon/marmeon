import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from './environment.ts';
import { computeInjectionArtifacts } from './injection/artifacts.ts';
import { compileMailView, jsxOptions, mailViewRefusal, OXC_TRANSFORM_RANGE, tsxFileOf } from './mail-views.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const register = fileURLToPath(new URL('./register.ts', import.meta.url));

/** A JSX runtime that returns plain objects, so no real React is needed. */
const runtime = (name: string) => `export const jsx = (type, props) => ({ runtime: '${name}', type, props });\nexport const jsxs = jsx;\nexport const Fragment = 'fragment';\n`;

describe('mail views in the load hook', () => {
  let root: string;
  const write = (path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const library = (name: string) => {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, type: 'module', exports: { './jsx-runtime': './jsx-runtime.js' } }));
    write(`node_modules/${name}/jsx-runtime.js`, runtime(name));
  };
  /** Runs `main.ts` of the app under the hook; `preload` is an extra `--import` module. */
  const run = (main: string, preload?: string) => {
    write('main.ts', main);
    const args = ['--import', register, ...(preload ? ['--import', join(root, preload)] : []), join(root, 'main.ts')];
    const { stdout, stderr, status, signal } = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' } });
    expect(signal, 'the child timed out').toBeNull();
    return { stdout, stderr, status };
  };
  /** Imports `path` and prints what happened: its default export as JSON, or the error. */
  const load = (path: string, preload?: string) =>
    run(
      `try { const view = await import(${JSON.stringify(join(root, path))}); console.log(JSON.stringify(view.default)); } catch (error) { console.log('ERROR ' + error.name + ': ' + error.message); }`,
      preload,
    );

  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mail-views-'));
    write('package.json', JSON.stringify({ type: 'module' }));
    library('react');
  });

  it('compiles a view of a module with the automatic runtime and removes its types', () => {
    write('modules/x/mail/View.tsx', "import type { Props } from './props.ts';\nconst View = (props: { name: string }) => <p title={props.name}>Hi</p>;\nexport default View({ name: 'Ada' });\n");
    const { stdout, status } = load('modules/x/mail/View.tsx');
    expect(stdout.trim()).toBe(JSON.stringify({ runtime: 'react', type: 'p', props: { title: 'Ada', children: 'Hi' } }));
    expect(status).toBe(0);
  });

  it('loads nothing for `import type`, and keeps an unused value import', () => {
    write('modules/x/mail/side.ts', "console.log('SIDE');\nexport const x = 1;\n");
    write('modules/x/mail/View.tsx', "import type { x } from './side.ts';\nexport default <i />;\n");
    expect(load('modules/x/mail/View.tsx').stdout).not.toContain('SIDE');
    write('modules/x/mail/View.tsx', "import { x } from './side.ts';\nexport default <i />;\n");
    expect(load('modules/x/mail/View.tsx').stdout).toContain('SIDE');
  });

  it('imports the runtime of jsxImportSource from the app tsconfig (with comments and trailing commas)', () => {
    library('preact');
    write('tsconfig.json', '// the app\n{ "compilerOptions": { /* JSX */ "jsx": "react-jsx", "jsxImportSource": "preact", }, }\n');
    write('modules/x/mail/View.tsx', 'export default <b />;\n');
    expect(JSON.parse(load('modules/x/mail/View.tsx').stdout)).toMatchObject({ runtime: 'preact', type: 'b' });
  });

  it('gives a class of a mail view its injection list', () => {
    write('modules/x/mail/Mailer.tsx', "import { Dep } from './Dep.ts';\nexport class Mailer { constructor(dep: Dep) {} }\nexport default Mailer.inject.map((dep) => dep.name);\n");
    write('modules/x/mail/Dep.ts', 'export class Dep {}\n');
    expect(load('modules/x/mail/Mailer.tsx').stdout.trim()).toBe('["Dep"]');
  });

  it('names file, line and column of a syntax error', () => {
    write('modules/x/mail/Broken.tsx', 'const a = 1;\nexport default <p>;\n');
    const { stdout } = load('modules/x/mail/Broken.tsx');
    expect(stdout).toMatch(/ERROR SyntaxError: .*modules\/x\/mail\/Broken\.tsx:\d+:\d+/);
  });

  it('reports the line of a syntax error after non-ASCII text (oxc counts bytes)', () => {
    write('modules/x/mail/Broken.tsx', 'const a = "Grüße 👋 €€€€";\nexport default <p>;\n');
    expect(load('modules/x/mail/Broken.tsx').stdout).toMatch(/Broken\.tsx:2:19 /);
    expect(() => compileMailView('/app/V.tsx', 'const a = "Grüße 👋 €€€€";\nexport default <p>;\n', { importSource: 'react' })).toThrow(/V\.tsx:2:19 /);
    // Columns count UTF-16 units (characters, for these), also when non-ASCII text sits on the error line itself.
    const line = 'const s = "ü€👋"; const a = (;';
    expect(() => compileMailView('/app/V.tsx', `${line}\n`, { importSource: 'react' })).toThrow(new RegExp(`V\\.tsx:1:${line.indexOf(';', line.indexOf('(')) + 1} `));
  });

  it('names the install command when oxc-transform has no transformSync', () => {
    write('modules/x/mail/View.tsx', 'export default <p />;\n');
    write('stub.cjs', 'module.exports = {};\n');
    write(
      'stub.mjs',
      `import { registerHooks } from 'node:module';\nimport { pathToFileURL } from 'node:url';\nregisterHooks({ resolve(specifier, context, next) { if (specifier === 'oxc-transform') return { url: pathToFileURL(${JSON.stringify(join(root, 'stub.cjs'))}).href, format: 'commonjs', shortCircuit: true }; return next(specifier, context); } });\n`,
    );
    expect(load('modules/x/mail/View.tsx', 'stub.mjs').stdout).toContain(`ERROR ConfigError: The installed oxc-transform has no transformSync; mail views need a version in ${OXC_TRANSFORM_RANGE}`);
  });

  describe('which TSX is loaded (red without the guard)', () => {
    const marker = "console.log('RAN');\nexport default <p />;\n";

    it('refuses a view outside modules/*/mail/ and compiles nothing', () => {
      write('modules/x/views/Page.tsx', marker);
      const { stdout } = load('modules/x/views/Page.tsx');
      expect(stdout).toMatch(/^ERROR Error: modules\/x\/views\/Page\.tsx is TSX outside modules\/<module>\/mail\//);
      expect(stdout).not.toContain('RAN');
    });

    it('refuses a path that leaves the mail folder with `..` (normalised by the URL), also through the import of another file', () => {
      write('modules/x/views/P.tsx', marker);
      write('modules/x/mail/Entry.ts', "import view from '../mail/../views/P.tsx';\nexport default view;\n");
      expect(load('modules/x/mail/Entry.ts').stdout).toMatch(/is TSX outside modules/);
      expect(load('modules/x/mail/../views/P.tsx').stdout).toMatch(/is TSX outside modules/);
    });

    it('refuses files directly in the module, in the app root and in a module without a mail folder', () => {
      for (const path of ['modules/x/Page.tsx', 'Page.tsx', 'modules/mail/View.tsx', 'modules/x/notmail/View.tsx']) {
        write(path, marker);
        const { stdout } = load(path);
        expect(stdout, path).toContain('is TSX outside modules');
        expect(stdout).not.toContain('RAN');
      }
    });

    it('refuses a folder whose name differs in case only, also under the lower-case spelling a case-insensitive file system accepts', () => {
      write('modules/x/Mail/View.tsx', marker);
      expect(load('modules/x/Mail/View.tsx').stdout).toContain('is TSX outside modules');
      // Only where the file system folds case does the other spelling reach the same file.
      if (existsSync(join(root, 'modules/x/mail/View.tsx'))) expect(load('modules/x/mail/View.tsx').stdout).toContain('is TSX outside modules');
      write('modules/x/mail2/View.TSX', marker);
      expect(load('modules/x/mail2/View.TSX').stdout).toContain('is TSX outside modules');
    });

    it('refuses a link in the mail folder that leads to a file outside the app', () => {
      const outside = realpathSync(tempDir('marmeon-mail-views-outside-'));
      writeFileSync(join(outside, 'Evil.tsx'), marker);
      mkdirSync(join(root, 'modules/x/mail'), { recursive: true });
      symlinkSync(join(outside, 'Evil.tsx'), join(root, 'modules/x/mail/Evil.tsx'));
      const { stdout } = load('modules/x/mail/Evil.tsx');
      expect(stdout).toContain('is TSX outside modules');
      expect(stdout).not.toContain('RAN');
    });

    it('refuses a link in the mail folder that leads to a file of the app outside it', () => {
      write('modules/x/views/P.tsx', marker);
      mkdirSync(join(root, 'modules/x/mail'), { recursive: true });
      symlinkSync(join(root, 'modules/x/views/P.tsx'), join(root, 'modules/x/mail/Alias.tsx'));
      const { stdout } = load('modules/x/mail/Alias.tsx');
      expect(stdout).toContain('is TSX outside modules');
      expect(stdout).not.toContain('RAN');
    });

    it('refuses a folder link: modules/x/mail leading to another directory', () => {
      write('modules/x/views/P.tsx', marker);
      symlinkSync(join(root, 'modules/x/views'), join(root, 'modules/x/mail'), 'dir');
      expect(load('modules/x/mail/P.tsx').stdout).toContain('is TSX outside modules');
    });

    it('leaves a .tsx below node_modules to Node (its own error), even inside a mail folder', () => {
      write('node_modules/lib/View.tsx', marker);
      write('modules/x/mail/node_modules/lib/View.tsx', marker);
      for (const path of ['node_modules/lib/View.tsx', 'modules/x/mail/node_modules/lib/View.tsx']) {
        const { stdout } = load(path);
        expect(stdout, path).toContain('Unknown file extension ".tsx"');
        expect(stdout).not.toContain('RAN');
      }
    });

    it('refuses "jsx": "preserve" (and any mode but the automatic runtime) with a ConfigError', () => {
      write('modules/x/mail/View.tsx', 'export default <p />;\n');
      for (const jsx of ['preserve', 'react', 'react-native']) {
        write('tsconfig.json', JSON.stringify({ compilerOptions: { jsx } }));
        const { stdout } = load('modules/x/mail/View.tsx');
        expect(stdout, jsx).toMatch(/^ERROR ConfigError: .*"jsx" is "/);
      }
    });

    it('refuses a jsxImportSource that is no package name', () => {
      write('modules/x/mail/View.tsx', 'export default <p />;\n');
      write('tsconfig.json', JSON.stringify({ compilerOptions: { jsxImportSource: 'react"; globalThis.pwned = 1; //' } }));
      expect(load('modules/x/mail/View.tsx').stdout).toMatch(/^ERROR ConfigError: .*"jsxImportSource" must be a package name/);
    });
  });

  it('names the install command when oxc-transform is missing', () => {
    write('modules/x/mail/View.tsx', 'export default <p />;\n');
    write(
      'hide.mjs',
      "import { registerHooks } from 'node:module';\nregisterHooks({ resolve(specifier, context, next) { if (specifier === 'oxc-transform') throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); return next(specifier, context); } });\n",
    );
    expect(load('modules/x/mail/View.tsx', 'hide.mjs').stdout).toContain(`ERROR ConfigError: Mail views are TSX and need oxc-transform to be compiled. Install it: pnpm add -D "oxc-transform@${OXC_TRANSFORM_RANGE}"`);
  });
});

describe('mailViewRefusal', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(tempDir('marmeon-mail-views-guard-'));
    mkdirSync(join(root, 'modules/x/mail'), { recursive: true });
    writeFileSync(join(root, 'modules/x/mail/View.tsx'), '');
    writeFileSync(join(root, 'Outside.tsx'), '');
  });

  it('accepts a view of a module and refuses what cannot be resolved or lies outside the app', () => {
    expect(mailViewRefusal(root, join(root, 'modules/x/mail/View.tsx'))).toBeUndefined();
    expect(mailViewRefusal(root, join(root, 'modules/x/mail/Missing.tsx'))).toMatch(/cannot be resolved/);
    expect(mailViewRefusal(root, join(root, 'Outside.tsx'))).toMatch(/^Outside\.tsx is TSX outside modules/);
    expect(mailViewRefusal(join(root, 'modules'), join(root, 'modules/x/mail/View.tsx'))).toMatch(/is TSX outside modules/);
  });

  it('refuses a link from outside the folder to a mail view, though the target is one', () => {
    mkdirSync(join(root, 'modules/x/views'), { recursive: true });
    symlinkSync(join(root, 'modules/x/mail/View.tsx'), join(root, 'modules/x/views/Borrowed.tsx'));
    expect(mailViewRefusal(root, join(root, 'modules/x/views/Borrowed.tsx'))).toMatch(/is TSX outside modules/);
  });

  it('refuses a file below a node_modules inside the mail folder', () => {
    mkdirSync(join(root, 'modules/x/mail/node_modules/lib'), { recursive: true });
    writeFileSync(join(root, 'modules/x/mail/node_modules/lib/V.tsx'), '');
    expect(mailViewRefusal(root, join(root, 'modules/x/mail/node_modules/lib/V.tsx'))).toMatch(/is TSX outside modules/);
  });

  it('refuses a link inside the mail folder to a file outside it or outside the app, judged by where it leads', () => {
    mkdirSync(join(root, 'modules/x/views'), { recursive: true });
    writeFileSync(join(root, 'modules/x/views/P.tsx'), '');
    const outside = realpathSync(tempDir('marmeon-mail-views-guard-outside-'));
    writeFileSync(join(outside, 'Evil.tsx'), '');
    symlinkSync(join(root, 'modules/x/views/P.tsx'), join(root, 'modules/x/mail/Alias.tsx'));
    symlinkSync(join(outside, 'Evil.tsx'), join(root, 'modules/x/mail/Evil.tsx'));
    expect(mailViewRefusal(root, join(root, 'modules/x/mail/Alias.tsx'))).toMatch(/is TSX outside modules/);
    expect(mailViewRefusal(root, join(root, 'modules/x/mail/Evil.tsx'))).toMatch(/is TSX outside modules/);
  });

  it.skipIf(process.platform === 'win32')('refuses a name with a backslash that only looks like a path out of the folder', () => {
    mkdirSync(join(root, 'modules/x/views'), { recursive: true });
    writeFileSync(join(root, 'modules/x/mail\\..\\views\\P.tsx'), '');
    writeFileSync(join(root, 'modules/x/mail/a\\b.tsx'), '');
    expect(mailViewRefusal(root, join(root, 'modules/x/mail\\..\\views\\P.tsx'))).toMatch(/is TSX outside modules/);
    expect(mailViewRefusal(root, join(root, 'modules/x/mail/a\\b.tsx'))).toMatch(/is TSX outside modules/);
  });

  it('refuses a `..` that leaves the folder, even when the file exists', () => {
    mkdirSync(join(root, 'modules/x/views'), { recursive: true });
    writeFileSync(join(root, 'modules/x/views/P.tsx'), '');
    expect(mailViewRefusal(root, `${root}/modules/x/mail/../views/P.tsx`)).toMatch(/is TSX outside modules/);
    expect(mailViewRefusal(root, `${root}/modules/x/mail/../mail/View.tsx`)).toBeUndefined();
  });
});

describe('tsxFileOf', () => {
  it('answers only for a .tsx file URL outside node_modules', () => {
    expect(tsxFileOf('file:///app/modules/x/mail/V.tsx')).toBe('/app/modules/x/mail/V.tsx');
    expect(tsxFileOf('file:///app/node_modules/x/V.tsx')).toBeUndefined();
    expect(tsxFileOf('file:///app/node_modules%2Fx/V.tsx')).toBeUndefined();
    expect(tsxFileOf('file:///app/a.ts')).toBeUndefined();
    expect(tsxFileOf('data:text/javascript,1')).toBeUndefined();
  });
});

describe('jsxOptions', () => {
  it('throws a ConfigError naming the path when tsconfig.json exists but cannot be read, not the defaults', () => {
    const root = tempDir('marmeon-mail-views-jsx-');
    mkdirSync(join(root, 'tsconfig.json'));
    expect(() => jsxOptions(root)).toThrow(/tsconfig\.json cannot be read \(EISDIR\)/);
    expect(() => jsxOptions(root)).toThrow(ConfigError);
  });

  it('defaults to react and throws a ConfigError for a tsconfig that is not JSON', () => {
    const root = tempDir('marmeon-mail-views-jsx-');
    expect(jsxOptions(root)).toEqual({ importSource: 'react' });
    const broken = tempDir('marmeon-mail-views-jsx-');
    writeFileSync(join(broken, 'tsconfig.json'), '{ "compilerOptions": ');
    expect(() => jsxOptions(broken)).toThrow(ConfigError);
  });
});

describe('the optional peer', () => {
  it('uses the range of the manifest, and the manifest marks it optional', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.peerDependencies['oxc-transform']).toBe(OXC_TRANSFORM_RANGE);
    expect(manifest.peerDependenciesMeta['oxc-transform']).toEqual({ optional: true });
    expect(manifest.dependencies['oxc-transform']).toBeUndefined();
  });
});

describe('computeInjectionArtifacts', () => {
  it('takes in a mail view and leaves a page view, a test and a link to another folder out', () => {
    const root = realpathSync(tempDir('marmeon-mail-views-artifacts-'));
    const source = "import { Dep } from './Dep.ts';\nexport class A { constructor(dep: Dep) {} }\n";
    for (const path of ['modules/x/mail/View.tsx', 'modules/x/views/Page.tsx', 'modules/x/mail/View.test.tsx', 'modules/x/mail/Mail.ts']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    symlinkSync(join(root, 'modules/x/views/Page.tsx'), join(root, 'modules/x/mail/Alias.tsx'));
    expect(Object.keys(computeInjectionArtifacts(root).files).sort()).toEqual(['modules/x/mail/Mail.ts', 'modules/x/mail/View.tsx']);
  });
});
