import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = import.meta.dirname;
const PACKAGE = join(SRC, '..', 'package.json');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|type-test)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

type Node = { type?: string; [key: string]: unknown };

/** oxc-parser, the parser of `@marmeon/core`: this package does not depend on it. */
const { parseSync } = createRequire(join(SRC, '..', '..', 'core', 'package.json'))('oxc-parser') as {
  parseSync(path: string, text: string): { program: Node; comments: { value: string }[]; errors: { message: string }[] };
};

/** What a specifier is when it is no string literal: never allowed. */
const NOT_A_LITERAL = '(not a string literal)';
/** What a way around the import check is reported as: never allowed. */
const CREATE_REQUIRE = '(createRequire)';
const REFERENCE = '(reference directive)';

/** `require` or `<anything>.require`. */
function isRequire(callee: Node): boolean {
  if (callee.type === 'Identifier') return callee.name === 'require';
  return callee.type === 'MemberExpression' && (callee.property as Node).name === 'require';
}

/**
 * Every module specifier of `source`, from its syntax tree: imports, exports from, dynamic imports, `import('x')` types,
 * `import x = require('x')` and `require` calls (also `module.require`), wherever they stand; plus `CREATE_REQUIRE` for every
 * `createRequire` (an import names it twice) and `REFERENCE` for every triple-slash `reference` directive. A specifier that is no string literal comes back as `NOT_A_LITERAL`.
 */
function specifiers(source: string, path = 'source.ts'): string[] {
  const { program, comments, errors } = parseSync(path, source);
  if (errors.length > 0) throw new Error(`${path}: ${errors[0]?.message}`);
  const found: string[] = [];
  const literal = (node: unknown): string => {
    const value = node as Node | null | undefined;
    return value?.type === 'Literal' && typeof value.value === 'string' ? value.value : NOT_A_LITERAL;
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== 'object') return;
    const current = node as Node;
    if ((current.type === 'ImportDeclaration' || current.type === 'ExportAllDeclaration') || (current.type === 'ExportNamedDeclaration' && current.source)) {
      found.push(literal(current.source));
    } else if (current.type === 'ImportExpression' || current.type === 'TSImportType') {
      found.push(literal(current.source));
    } else if (current.type === 'TSExternalModuleReference') {
      found.push(literal(current.expression));
    } else if (current.type === 'CallExpression' && isRequire(current.callee as Node)) {
      found.push(literal((current.arguments as unknown[])[0]));
    } else if (current.type === 'Identifier' && current.name === 'createRequire') {
      found.push(CREATE_REQUIRE);
    }
    for (const value of Object.values(current)) visit(value);
  };
  visit(program);
  for (const comment of comments) if (/^\/\s*<reference\s/.test(comment.value)) found.push(REFERENCE);
  return found;
}

const allowed = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:') || specifier.startsWith('@marmeon/') || specifier === 'valibot';

describe('no provider SDK', () => {
  it('finds the sources it is meant to check', () => {
    const files = sources(SRC).map((path) => path.slice(SRC.length + 1));
    expect(files).toEqual(expect.arrayContaining(['raw.ts', 'escape.ts', 'drivers/slack.ts', 'drivers/discord.ts', 'drivers/teams.ts']));
  });

  it('imports only the package itself, node:, @marmeon/* and valibot', () => {
    for (const file of sources(SRC)) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'), file)) {
        expect(allowed(specifier), `${file.slice(SRC.length + 1)} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('refuses what is outside the allow-list', () => {
    for (const specifier of ['@slack/webhook', 'discord.js', 'axios', 'node-fetch', 'undici', 'slack', 'valibot/x', 'marmeon', '/abs/path', 'http://x']) {
      expect(allowed(specifier), specifier).toBe(false);
    }
  });

  it('reads import forms the check must not miss', () => {
    const source = [
      "import a from 'axios';",
      'export { b } from "undici";',
      "export * from 'ws';",
      "const ACCEPT = '*/*';",
      "const c = await import('slack');",
      "import 'side-effect';",
      "const d = require('node-fetch');",
      "import e from 'one'; import f from 'two';",
      "// import g from 'in-a-comment';",
      "const text = \"import h from 'in-a-string'\";",
      'const e2 = await import(name);',
      "type B = import('@slack/types').Block;",
      "type C = typeof import('discord.js');",
      "import sdk = require('sdk-a');",
      "export import sdk2 = require('sdk-b');",
      "const f2 = module.require('sdk-c');",
      "import { createRequire } from 'node:module';",
      '/// <reference types="node" />',
      '/// <reference path="./x.d.ts" />',
    ].join('\n');
    expect(specifiers(source).sort()).toEqual(
      ['@slack/types', 'axios', 'discord.js', 'node-fetch', 'node:module', 'one', 'sdk-a', 'sdk-b', 'sdk-c', 'side-effect', 'slack', 'two', 'undici', 'ws', NOT_A_LITERAL, CREATE_REQUIRE, CREATE_REQUIRE, REFERENCE, REFERENCE].sort(),
    );
  });

  it('refuses a specifier that is no string literal', () => {
    expect(allowed(NOT_A_LITERAL)).toBe(false);
    expect(allowed(CREATE_REQUIRE)).toBe(false);
    expect(allowed(REFERENCE)).toBe(false);
  });

  it('declares no dependency outside @marmeon/* and valibot', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE, 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        expect(name === 'valibot' || name.startsWith('@marmeon/'), `${section}: ${name}`).toBe(true);
      }
    }
  });
});
