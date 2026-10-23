/**
 * Holds the table "Provider statics" of docs/package-development.md to the code: the members of `ServiceProviderClass` in
 * `@marmeon/core` and of every `declare module '@marmeon/core'` extension of it in the packages must be exactly the table's rows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_STATICS } from '../packages/core/src/application.ts';
import { oxc, PACKAGE_CODE, type SourceFile } from './source-files.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
export const PAGE = 'docs/package-development.md';
const CORE_PROVIDER = 'packages/core/src/provider.ts';

interface Node {
  type: string;
  [key: string]: any;
}

/** The members of the `ServiceProviderClass` interfaces in a file: the interface of the core, or an extension of it in a module declaration. */
function members(file: SourceFile, name = 'ServiceProviderClass', home = CORE_PROVIDER): string[] {
  if (!file.text.includes(name)) return [];
  const { program, errors } = oxc().parseSync(file.path, file.text);
  if (errors.length > 0) throw new Error(`${file.path}: oxc-parser cannot read it: ${errors[0]!.message}`);

  const found: string[] = [];
  const takeFrom = (statements: readonly Node[]) => {
    for (const statement of statements) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (declaration?.type !== 'TSInterfaceDeclaration' || declaration.id.name !== name) continue;
      for (const member of declaration.body.body as Node[]) {
        if (member.type !== 'TSPropertySignature' && member.type !== 'TSMethodSignature') continue;
        const key = member.key as Node;
        found.push(String(key.type === 'Identifier' ? key.name : key.value));
      }
    }
  };

  for (const statement of (program as { body: Node[] }).body) {
    if (file.path === home) takeFrom([statement]);
    const isExtension = statement.type === 'TSModuleDeclaration' && statement.id?.value === '@marmeon/core';
    if (isExtension && statement.body?.body) takeFrom(statement.body.body);
  }
  return found;
}

/** The statics of a provider class that the code declares, sorted. */
export function providerStatics(files: Iterable<SourceFile>): string[] {
  const names = new Set<string>();
  for (const file of files) {
    if (!PACKAGE_CODE.test(file.path)) continue;
    for (const name of members(file)) names.add(name);
  }
  return [...names].sort();
}

/** The first cell of each row of the page's "Provider statics" table, sorted. */
export function documentedStatics(markdown: string): string[] {
  const start = markdown.search(/^### Provider statics$/m);
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of markdown.slice(start).split('\n').slice(1)) {
    if (/^#{1,3} /.test(line)) break;
    const cell = /^\| `([A-Za-z_$][\w$]*)` \|/.exec(line);
    if (cell) names.push(cell[1]!);
  }
  return names.sort();
}

/** What differs between the code and the page, as lines for a person. */
export function protocolProblems(files: Iterable<SourceFile>, markdown: string): string[] {
  const code = providerStatics(files);
  const page = documentedStatics(markdown);
  if (page.length === 0) return [`${PAGE}: no table under "### Provider statics"`];
  const problems: string[] = [];
  for (const name of code) if (!page.includes(name)) problems.push(`${PAGE}: the table "Provider statics" lacks \`${name}\`, which ServiceProviderClass declares`);
  for (const name of page) if (!code.includes(name)) problems.push(`${PAGE}: the table "Provider statics" lists \`${name}\`, which no ServiceProviderClass declares`);
  return problems;
}

/** The sources of the packages as the repository has them on disk. */
export function packageSources(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(join(root, 'packages', entry.name, 'src'), { recursive: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const name of names) {
      const path = `packages/${entry.name}/src/${name.split('\\').join('/')}`;
      if (PACKAGE_CODE.test(path)) files.push({ path, text: readFileSync(join(root, path), 'utf8') });
    }
  }
  return files;
}

export function pageText(): string {
  return readFileSync(join(root, PAGE), 'utf8');
}

/** The statics a repository class declares (`RepositoryStatics` in `@marmeon/database`). */
export function repositoryStatics(files: Iterable<SourceFile>): string[] {
  const names: string[] = [];
  for (const file of files) if (file.path === 'packages/database/src/repository.ts') names.push(...members(file, 'RepositoryStatics', file.path));
  return names.sort();
}

/** The statics that the page's "Statics of other classes" table names, in backticks. */
export function documentedClassStatics(markdown: string): Set<string> {
  const start = markdown.search(/^### Statics of other classes$/m);
  const found = new Set<string>();
  if (start === -1) return found;
  for (const line of markdown.slice(start).split('\n').slice(1)) {
    if (/^#{1,3} /.test(line)) break;
    const cells = line.split('|');
    if (cells.length < 4) continue;
    for (const match of (cells[2] ?? '').matchAll(/`([A-Za-z_$][\w$]*)`/g)) found.add(match[1]!);
  }
  return found;
}

/** The statics the core's provider check (K9) counts, sorted. */
export const startupStatics = (): string[] => [...PROVIDER_STATICS].sort();
