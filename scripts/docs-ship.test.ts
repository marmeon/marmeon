import { existsSync, mkdirSync, symlinkSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedDocs, shipDocs } from './docs-ship.ts';
import { checkDocsInTarball } from './pack-check.ts';
import { tempDir } from './test/temp-dir.js';

/** A repository with two pages, a policy page and the three policies; `target` is its `packages/cli`. */
function repository(): { root: string; target: string } {
  const root = tempDir('marmeon-docs-ship-');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'apps/website'), { recursive: true });
  mkdirSync(join(root, 'packages/cli'), { recursive: true });
  writeFileSync(join(root, 'docs/routing.md'), '# Routing\r\n\nSee [upgrading](../UPGRADING.md).\n```md\n# not a title\n```\n');
  writeFileSync(join(root, 'docs/mail.md'), '# Mail\n');
  for (const name of ['UPGRADING', 'SECURITY', 'CONTRIBUTING']) writeFileSync(join(root, `${name}.md`), `# ${name}\n`);
  writeFileSync(join(root, 'packages/cli/package.json'), JSON.stringify({ name: 'marmeon', version: '1.2.3' }));
  writeFileSync(
    join(root, 'apps/website/docs.config.ts'),
    `export default { sections: [
      { title: 'Basics', pages: [{ slug: 'routing', label: 'Routing' }, { slug: 'mail', label: 'Mail' }] },
      { title: 'Prologue', pages: [{ slug: 'upgrading', label: 'Upgrade Guide', file: 'UPGRADING.md' }] },
    ] };\n`,
  );
  return { root, target: join(root, 'packages/cli') };
}

const HINT = "the docs in the tarball are not the repository's — is every path named in \"files\" of packages/cli/package.json?";
const read = (target: string, path: string) => readFileSync(join(target, path));
const tree = (target: string) => (readdirSync(join(target, 'docs'), { recursive: true }) as string[]).sort();

describe('shipDocs', () => {
  it('copies the pages and the policies byte for byte', async () => {
    const { root, target } = repository();
    await shipDocs(root, target);
    for (const path of ['docs/routing.md', 'docs/mail.md', 'UPGRADING.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
      expect(read(target, path).equals(readFileSync(join(root, path)))).toBe(true);
    }
  });

  it('writes index.json (format 1) with the titles and the order of the config', async () => {
    const { root, target } = repository();
    await shipDocs(root, target);
    expect(JSON.parse(read(target, 'docs/index.json').toString('utf8'))).toEqual({
      format: 1,
      version: '1.2.3',
      sections: [
        {
          title: 'Basics',
          pages: [
            { slug: 'routing', label: 'Routing', title: 'Routing', file: 'docs/routing.md' },
            { slug: 'mail', label: 'Mail', title: 'Mail', file: 'docs/mail.md' },
          ],
        },
        { title: 'Prologue', pages: [{ slug: 'upgrading', label: 'Upgrade Guide', title: 'UPGRADING', file: 'UPGRADING.md' }] },
      ],
    });
  });

  it('writes llms.txt with relative links only', async () => {
    const { root, target } = repository();
    await shipDocs(root, target);
    const text = read(target, 'docs/llms.txt').toString('utf8');
    expect(text).toContain('- [Routing](routing.md)');
    expect(text).toContain('- [UPGRADING](../UPGRADING.md)');
    expect(text).not.toMatch(/https?:/);
  });

  it('is the same on a second run', async () => {
    const { root, target } = repository();
    await shipDocs(root, target);
    const first = new Map((await expectedDocs(root)).entries());
    await shipDocs(root, target);
    for (const [path, bytes] of first) expect(read(target, path).equals(bytes)).toBe(true);
    expect(tree(target)).toEqual(['index.json', 'llms.txt', 'mail.md', 'routing.md']);
  });

  it('removes a page that is gone from the repository', async () => {
    const { root, target } = repository();
    writeFileSync(join(root, 'docs/extra.md'), '# Extra\n');
    await shipDocs(root, target);
    expect(existsSync(join(target, 'docs/extra.md'))).toBe(true);
    rmSync(join(root, 'docs/extra.md'));
    await shipDocs(root, target);
    expect(existsSync(join(target, 'docs/extra.md'))).toBe(false);
  });

  it('refuses a symlink in docs/', async () => {
    const { root } = repository();
    symlinkSync(join(root, 'SECURITY.md'), join(root, 'docs/evil.md'));
    await expect(expectedDocs(root)).rejects.toThrow('docs/evil.md is not a regular .md file');
  });

  it('skips a .DS_Store in docs/', async () => {
    const { root } = repository();
    writeFileSync(join(root, 'docs/.DS_Store'), 'x');
    expect([...(await expectedDocs(root)).keys()]).not.toContain('docs/.DS_Store');
  });

  it('refuses a directory in docs/', async () => {
    const { root } = repository();
    mkdirSync(join(root, 'docs/images'));
    await expect(expectedDocs(root)).rejects.toThrow('docs/images is not a regular .md file');
  });

  it('refuses a policy that is a symlink', async () => {
    const { root } = repository();
    rmSync(join(root, 'SECURITY.md'));
    symlinkSync(join(root, 'docs/mail.md'), join(root, 'SECURITY.md'));
    await expect(expectedDocs(root)).rejects.toThrow('SECURITY.md is not a regular file');
  });

  it('is run by the root build script', () => {
    const scripts = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.build).toContain('scripts/docs-ship.ts');
  });

  it('refuses a page the config lists and the repository lacks', async () => {
    const { root } = repository();
    rmSync(join(root, 'docs/mail.md'));
    await expect(expectedDocs(root)).rejects.toThrow('docs/mail.md does not exist');
  });
});

describe('checkDocsInTarball', () => {
  async function shipped() {
    const { root, target } = repository();
    await shipDocs(root, target);
    const expected = await expectedDocs(root);
    return { target, expected, files: [...expected.keys()] };
  }

  it('accepts the docs of the repository', async () => {
    const { target, expected, files } = await shipped();
    expect(checkDocsInTarball({ files }, target, expected)).toEqual([]);
  });

  it('names a missing page', async () => {
    const { target, expected, files } = await shipped();
    const problems = checkDocsInTarball({ files: files.filter((file) => file !== 'docs/mail.md') }, target, expected);
    expect(problems).toEqual(['docs/mail.md is missing', HINT]);
  });

  it('names a changed page', async () => {
    const { target, expected, files } = await shipped();
    writeFileSync(join(target, 'docs/mail.md'), '# Mail, edited\n');
    const problems = checkDocsInTarball({ files }, target, expected);
    expect(problems).toEqual(["docs/mail.md is not the repository's", HINT]);
  });

  it('names an additional page', async () => {
    const { target, expected, files } = await shipped();
    const problems = checkDocsInTarball({ files: [...files, 'docs/extra.md'] }, target, expected);
    expect(problems).toEqual(["docs/extra.md is no page of the repository's docs", HINT]);
  });
});
