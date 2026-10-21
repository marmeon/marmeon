import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Container } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';
import { BUILT_IN } from './built-in.ts';
import { DocsCommand, DocsLocation } from './commands/docs.ts';
import { Output } from './output.ts';

const formats = new URL('./__fixtures__/formats/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, formats), 'utf8');
const indexFixtures = readdirSync(new URL('docs-index/', formats));

const PAGES: Record<string, string> = {
  'docs/routing.md': '# Routing\n\nRoutes map paths to actions.\n',
  'docs/validation.md': '# Validation\n\nRules.\n',
  'UPGRADING.md': '# Upgrading\n\nNothing yet.\n',
};

/** A `marmeon` package in a temporary directory, with the pages the fixture index lists. */
function installation(index: string | null = read('docs-index/v1.json'), pages: Record<string, string> = PAGES) {
  const packageRoot = tempDir('marmeon-docs-');
  mkdirSync(join(packageRoot, 'docs'));
  if (index !== null) writeFileSync(join(packageRoot, 'docs/index.json'), index);
  for (const [file, text] of Object.entries(pages)) writeFileSync(join(packageRoot, file), text);
  return packageRoot;
}

class Capture extends Output {
  readonly out: string[] = [];
  readonly err: string[] = [];
  constructor() {
    const out: string[] = [];
    super((text) => void out.push(text));
    this.out = out;
  }
  override error(text: string): void {
    this.err.push(text);
  }
  get stdout(): string {
    return this.out.join('');
  }
}

/** Runs `marmeon docs` against `packageRoot` the way `main.ts` does: arguments split from options, the cwd as the root. */
function docs(packageRoot: string, args: string[] = [], options: { path?: boolean; json?: boolean } = {}, cwd = packageRoot) {
  const location = Object.defineProperty(new DocsLocation(), 'directory', { value: join(packageRoot, 'docs') });
  const output = new Capture();
  const code = new DocsCommand(location).handle({ args, options, output, root: cwd } as never);
  return { code, stdout: output.stdout, stderr: output.err.join('\n') };
}

describe('marmeon docs', () => {
  it('lists the sections and pages with the file relative to the working directory, and the newest version online', () => {
    const packageRoot = installation();
    const { code, stdout } = docs(packageRoot, [], {}, join(packageRoot, 'docs'));
    expect(code).toBe(0);
    expect(stdout).toMatch(/Prologue\n\s+upgrading\s+Upgrading\s+\.\.\/UPGRADING\.md\n/);
    expect(stdout).toMatch(/The Basics\n\s+routing\s+Routing\s+routing\.md\n\s+validation\s+Validation\s+validation\.md\n/);
    expect(stdout.indexOf('Prologue')).toBeLessThan(stdout.indexOf('The Basics'));
    expect(stdout.trimEnd().endsWith('The newest version online: https://marmeon.com/docs')).toBe(true);
  });

  it('prints the page unchanged for its slug, with .md and with an anchor', () => {
    const packageRoot = installation();
    for (const name of ['routing', 'routing.md', 'routing#routes', 'routing.md#routes']) {
      expect(docs(packageRoot, [name])).toMatchObject({ code: 0, stdout: PAGES['docs/routing.md'] });
    }
    expect(docs(packageRoot, ['upgrading'])).toMatchObject({ code: 0, stdout: PAGES['UPGRADING.md'] });
  });

  it('prints a page that does not end with a newline with one', () => {
    const packageRoot = installation(read('docs-index/v1.json'), { ...PAGES, 'docs/routing.md': '# Routing' });
    expect(docs(packageRoot, ['routing']).stdout).toBe('# Routing\n');
  });

  it('prints only the absolute path with --path', () => {
    const packageRoot = installation();
    expect(docs(packageRoot, ['routing'], { path: true })).toMatchObject({ code: 0, stdout: `${join(packageRoot, 'docs/routing.md')}\n` });
    expect(docs(packageRoot, ['upgrading'], { path: true }).stdout).toBe(`${join(packageRoot, 'UPGRADING.md')}\n`);
  });

  it('shows the path through node_modules/marmeon of the app when the package is linked there, as pnpm does', () => {
    const packageRoot = installation();
    const app = tempDir('marmeon-docs-app-');
    mkdirSync(join(app, 'node_modules'));
    symlinkSync(packageRoot, join(app, 'node_modules/marmeon'), 'dir');
    const shown = join(app, 'node_modules/marmeon');
    expect(docs(packageRoot, ['routing'], { path: true }, app).stdout).toBe(`${join(shown, 'docs/routing.md')}\n`);
    expect(docs(packageRoot, ['routing'], {}, app).stdout).toBe(PAGES['docs/routing.md']);
    expect(JSON.parse(docs(packageRoot, [], { json: true }, app).stdout)).toMatchObject({ root: shown });
    expect(docs(packageRoot, [], {}, app).stdout).toContain(join('node_modules/marmeon/docs/routing.md'));
    expect(docs(packageRoot, [], {}, app).stdout).not.toContain(packageRoot);
    // Another package under that name is not this one.
    const other = tempDir('marmeon-docs-app-');
    mkdirSync(join(other, 'node_modules'));
    symlinkSync(installation(), join(other, 'node_modules/marmeon'), 'dir');
    expect(docs(packageRoot, ['routing'], { path: true }, other).stdout).toBe(`${join(packageRoot, 'docs/routing.md')}\n`);
  });

  it('finds node_modules/marmeon of the app from a folder below it, skipping another package of that name', () => {
    const packageRoot = installation();
    const app = tempDir('marmeon-docs-app-');
    mkdirSync(join(app, 'node_modules'));
    symlinkSync(packageRoot, join(app, 'node_modules/marmeon'), 'dir');
    const shown = join(app, 'node_modules/marmeon');
    const below = join(app, 'modules/x');
    mkdirSync(below, { recursive: true });
    expect(docs(packageRoot, ['routing'], { path: true }, below).stdout).toBe(`${join(shown, 'docs/routing.md')}\n`);
    expect(JSON.parse(docs(packageRoot, [], { json: true }, below).stdout)).toMatchObject({ root: shown });

    // A closer node_modules/marmeon that is another package is passed over, not shown.
    mkdirSync(join(below, 'node_modules'));
    symlinkSync(installation(), join(below, 'node_modules/marmeon'), 'dir');
    expect(docs(packageRoot, ['routing'], { path: true }, below).stdout).toBe(`${join(shown, 'docs/routing.md')}\n`);

    // Without any link to this package, the package's own path is shown.
    const lone = tempDir('marmeon-docs-app-');
    mkdirSync(join(lone, 'node_modules'));
    symlinkSync(installation(), join(lone, 'node_modules/marmeon'), 'dir');
    mkdirSync(join(lone, 'sub/node_modules'), { recursive: true });
    symlinkSync(join(lone, 'missing'), join(lone, 'sub/node_modules/marmeon'), 'dir');
    expect(docs(packageRoot, ['routing'], { path: true }, join(lone, 'sub')).stdout).toBe(`${join(packageRoot, 'docs/routing.md')}\n`);
    expect(JSON.parse(docs(packageRoot, [], { json: true }, join(lone, 'sub')).stdout)).toMatchObject({ root: packageRoot });
  });

  it('refuses --path without a page, --json with a page, and a second page, with exit 2', () => {
    const packageRoot = installation();
    expect(docs(packageRoot, [], { path: true })).toMatchObject({ code: 2, stdout: '' });
    expect(docs(packageRoot, ['routing'], { json: true })).toMatchObject({ code: 2, stdout: '' });
    expect(docs(packageRoot, ['routing', 'validation'])).toMatchObject({ code: 2, stdout: '' });
  });

  it('exits with 2 for an unknown page and suggests similar slugs, at most five', () => {
    const pages = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((letter) => [`docs/route-${letter}.md`, `# ${letter}\n`]));
    const index = JSON.stringify({
      format: 1,
      version: '0.3.0',
      sections: [{ title: 'All', pages: [...Object.keys(pages).map((file) => ({ slug: file.slice(5, -3), label: file, title: file, file })), { slug: 'cache', label: 'Cache', title: 'Cache', file: 'docs/cache.md' }] }],
    });
    const packageRoot = installation(index, { ...pages, 'docs/cache.md': '# Cache\n' });
    const missing = docs(packageRoot, ['route']);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('There is no page "route"');
    expect(missing.stderr.match(/route-[a-g]/g)).toHaveLength(5);
    expect(missing.stderr).not.toContain('cache');

    const typo = docs(installation(), ['routin']);
    expect(typo.stderr).toContain('Did you mean routing?');
    expect(docs(installation(), ['zzzzzz']).stderr).toContain('Run marmeon docs to list the pages.');
  });

  describe('a page name is looked up, never used as a path', () => {
    const outside = (packageRoot: string) => {
      writeFileSync(join(packageRoot, 'package.json'), '{ "name": "secret-package" }\n');
    };

    it('refuses names that point out of the docs, with exit 2 and nothing on stdout', () => {
      const packageRoot = installation();
      outside(packageRoot);
      const attempts = [
        '../package',
        '../package.json',
        '../UPGRADING',
        'docs/../UPGRADING',
        'docs/routing',
        'docs/routing.md',
        './routing',
        'routing/../routing',
        '../../etc/passwd',
        '%2e%2e/package',
        '%2e%2e%2fpackage',
        '..%2fpackage',
        '/etc/passwd',
        join(packageRoot, 'docs/routing.md'),
        '..\\package',
        'routing\0',
        'routing.md.md',
        'index',
        'index.json',
        'llms',
        'llms.txt',
        '__proto__',
        'constructor',
        '',
        '#routing',
      ];
      for (const attempt of attempts) {
        for (const options of [{}, { path: true }]) {
          const result = docs(packageRoot, [attempt], options);
          expect(result, JSON.stringify(attempt)).toMatchObject({ code: 2, stdout: '' });
        }
      }
    });

    it('does not print a file an index entry names outside the package, with exit 1', () => {
      for (const file of ['../package.json', '../../etc/passwd', '/etc/passwd', 'docs/../package.json', 'docs/sub/page.md', 'docs/page.txt', 'C:\\x.md', 'docs/.hidden.md']) {
        const index = JSON.stringify({ format: 1, version: '0.3.0', sections: [{ title: 'Bad', pages: [{ slug: 'bad', label: 'Bad', title: 'Bad', file }] }] });
        const packageRoot = installation(index, {});
        outside(packageRoot);
        const result = docs(packageRoot, ['bad']);
        expect(result, file).toMatchObject({ code: 1, stdout: '' });
        expect(result.stderr, file).toContain('malformed');
      }
    });

    it('does not follow a symlink in the docs, with exit 1', () => {
      const packageRoot = installation();
      outside(packageRoot);
      const target = join(tempDir('marmeon-docs-target-'), 'secret.md');
      writeFileSync(target, '# secret\n');
      symlinkSync(target, join(packageRoot, 'docs/linked.md'));
      const index = JSON.stringify({ format: 1, version: '0.3.0', sections: [{ title: 'S', pages: [{ slug: 'linked', label: 'L', title: 'L', file: 'docs/linked.md' }] }] });
      writeFileSync(join(packageRoot, 'docs/index.json'), index);
      for (const options of [{}, { path: true }]) {
        expect(docs(packageRoot, ['linked'], options)).toMatchObject({ code: 1, stdout: '' });
      }
    });

    it('does not read an index that is a symlink', () => {
      const packageRoot = installation(null);
      const target = join(tempDir('marmeon-docs-target-'), 'index.json');
      writeFileSync(target, read('docs-index/v1.json'));
      symlinkSync(target, join(packageRoot, 'docs/index.json'));
      expect(docs(packageRoot)).toMatchObject({ code: 1, stdout: '' });
    });
  });

  it('exits with 1 and says to build when the documentation is not there', () => {
    const missing = docs(installation(null));
    expect(missing).toMatchObject({ code: 1, stdout: '' });
    expect(missing.stderr).toContain('The docs are not in this installation of marmeon — in the repository, run pnpm build.');
    expect(docs(installation(null), ['routing'])).toMatchObject({ code: 1, stdout: '' });
  });

  it('exits with 1 for an index of another format, a broken one and a page whose file is missing', () => {
    const other = docs(installation(JSON.stringify({ ...JSON.parse(read('docs-index/v1.json')), format: 2 })));
    expect(other).toMatchObject({ code: 1, stdout: '' });
    expect(other.stderr).toContain('format 2');
    expect(docs(installation(JSON.stringify({ version: '1' })))).toMatchObject({ code: 1 });
    expect(docs(installation('{ not json'))).toMatchObject({ code: 1, stdout: '' });
    expect(docs(installation(JSON.stringify({ format: 1, version: '0.3.0', sections: 'x' })))).toMatchObject({ code: 1 });
    const gone = docs(installation(read('docs-index/v1.json'), { 'UPGRADING.md': 'x\n' }), ['routing']);
    expect(gone).toMatchObject({ code: 1, stdout: '' });
    expect(gone.stderr).toContain('not a file of this installation');
  });

  it('is built by the container with the location of the package', () => {
    const command = new Container().make(DocsCommand as never);
    expect(command).toBeInstanceOf(DocsCommand);
    const directory = new DocsLocation().directory;
    expect(directory).toBe(join(repo, 'packages/cli/docs'));
  });

  it('is a built-in that does not boot the app', () => {
    expect(BUILT_IN).toContain(DocsCommand);
    expect(DocsCommand.boots).toBe(false);
  });
});

describe('docs --json', () => {
  it('prints the format of the stored fixture, with the root of the package', () => {
    const packageRoot = installation();
    const { code, stdout, stderr } = docs(packageRoot, [], { json: true });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const document = JSON.parse(stdout) as { root: string };
    expect(Object.keys(document)[0]).toBe('format');
    expect(document.root).toBe(packageRoot);
    expect({ ...document, root: '<root>' }).toEqual(JSON.parse(read('cli-docs/v1.json')));
    // No release line and no online address per page: the document says what is installed.
    expect(stdout).not.toMatch(/"(line|url|label)"/);
  });

  it('fails without a document when the docs are missing', () => {
    expect(docs(installation(null), [], { json: true })).toMatchObject({ code: 1, stdout: '' });
  });

  it('reads every stored index and prints a document for each', () => {
    expect(indexFixtures).toContain('v1.json');
    for (const name of indexFixtures) {
      const result = docs(installation(read(`docs-index/${name}`)), [], { json: true });
      expect(result.code, name).toBe(0);
      expect(JSON.parse(result.stdout), name).toMatchObject({ format: 1 });
    }
    expect(readdirSync(new URL('cli-docs/', formats))).toContain('v1.json');
  });
});

describe('marmeon docs in the repository', () => {
  const shipped = join(repo, 'packages/cli/docs/index.json');
  const app = tempDir('marmeon-docs-cwd-');

  it('lists the shipped pages, or says to build when the copy is not there', () => {
    const result = marmeon(app, ['docs', '--json']);
    if (!existsSync(shipped)) {
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain('run pnpm build');
      return;
    }
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as { root: string; sections: { pages: { slug: string; file: string }[] }[] };
    expect(document.root).toBe(join(repo, 'packages/cli'));
    const routing = document.sections.flatMap((section) => section.pages).find((page) => page.slug === 'routing');
    expect(routing?.file).toBe('docs/routing.md');
    expect(marmeon(app, ['docs', 'routing']).stdout).toBe(readFileSync(join(repo, 'docs/routing.md'), 'utf8'));
    expect(marmeon(app, ['docs', '../package'])).toMatchObject({ code: 2, stdout: '' });
  });
});
