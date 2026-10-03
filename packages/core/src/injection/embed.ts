import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';
import { analyzeInjections, classesOf, InjectionError, insertInjections, UNRESOLVABLE, WARNINGS, type InjectionSite } from './analyze.ts';
import { matchesBrowserSource } from './browser.ts';

type Node = { type: string; start: number; [key: string]: any };

/**
 * Embeds injection lists into *compiled* JavaScript, using the TypeScript source
 * as the source of types. This is what `bespoke package:build` runs after `tsc`,
 * so published packages carry their lists and consumers need no extra step.
 */
export function embedInjections(tsSource: string, tsFile: string, jsSource: string, jsFile: string): string {
  const sites = analyzeInjections(tsSource, tsFile);
  if (sites.length === 0) return jsSource;

  const { program } = parseSync(jsFile, jsSource);
  // Classes pair up by position: tsc keeps their order (target ESNext rewrites none of them).
  const jsClasses = classesOf(program);
  const jsValues = new Set<string>();
  for (const statement of program.body as Node[]) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) jsValues.add(specifier.local.name);
    }
    const declaration =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;
    if (declaration?.type === 'ClassDeclaration' && declaration.id) jsValues.add(declaration.id.name);
    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) jsValues.add(declarator.id.name);
    }
  }

  const jsSites: InjectionSite[] = [];
  for (const site of sites) {
    const js = jsClasses[site.classIndex];
    if (!js || js.name !== site.className) {
      throw new InjectionError(`${jsFile}: compiled output has no class "${site.className}" at position ${site.classIndex + 1}.`);
    }
    const { node } = js;
    // Idempotent: `tsc -b` skips up-to-date projects, so dist/ may already carry the field.
    if (alreadyEmbedded(node, jsSource)) continue;
    for (const dependency of 'dependencies' in site ? site.dependencies : []) {
      const root = dependency.split('.')[0]!;
      if (!jsValues.has(root)) {
        throw new InjectionError(
          `${jsFile}: "${root}" (needed by ${site.className}) was removed from the compiled imports. ` +
            'Enable "verbatimModuleSyntax" so tsc keeps value imports that are only used in type positions.',
        );
      }
    }
    jsSites.push({ ...site, bodyStart: node.body.start });
  }

  return insertInjections(jsSource, jsSites);
}

function alreadyEmbedded(classNode: Node, source: string): boolean {
  return classNode.body.body.some((member: Node) => isInjectionField(member, source));
}

function isInjectionField(member: Node, source: string): boolean {
  if (!member.static) return false;
  if (member.key?.name === 'inject') return true;
  const key = member.computed ? source.slice(member.key.start, member.key.end) : '';
  return key.includes(UNRESOLVABLE) || key.includes(WARNINGS);
}

/**
 * Takes out what {@link embedInjections} inserted — only fields right after a class body's `{`, where it puts them,
 * never a list someone wrote by hand. For browser sources whose `dist/` still carries fields from an earlier build
 * (`tsc -b` leaves up-to-date output untouched).
 */
export function removeEmbeddedInjections(jsSource: string, jsFile: string): string {
  if (!jsSource.includes('static inject') && !jsSource.includes(UNRESOLVABLE) && !jsSource.includes(WARNINGS)) return jsSource;
  const { program } = parseSync(jsFile, jsSource);
  const spans: [number, number][] = [];
  for (const { node } of classesOf(program)) {
    let at = node.body.start + 1;
    for (const member of node.body.body as Node[]) {
      if (member.start !== at + 1 || jsSource[at] !== ' ' || !isInjectionField(member, jsSource)) break;
      const end = jsSource[member.end] === ';' ? member.end + 1 : member.end;
      spans.push([at, end]);
      at = end;
    }
  }
  let output = jsSource;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) output = output.slice(0, start) + output.slice(end);
  return output;
}

export interface EmbedPackageOptions {
  /** TypeScript sources (tsconfig `rootDir`). */
  srcDir: string;
  /** Compiled output (tsconfig `outDir`). */
  outDir: string;
  /**
   * Browser-only sources, as globs relative to the package directory (the parent of `srcDir`) — the package's
   * `"bespoke": { "browser": [...] }`. Their classes get nothing (roadmap E76), and fields an earlier build left there are taken out.
   */
  browser?: readonly string[];
}

/** Runs {@link embedInjections} over a whole package. Returns the files that changed. */
export function embedPackageInjections({ srcDir, outDir, browser = [] }: EmbedPackageOptions): string[] {
  const changed: string[] = [];

  for (const tsFile of walk(srcDir)) {
    if (!/\.tsx?$/.test(tsFile) || /\.(d|test)\.tsx?$/.test(tsFile)) continue;
    const jsFile = join(outDir, relative(srcDir, tsFile)).replace(/\.tsx?$/, '.js');

    let jsSource: string;
    try {
      jsSource = readFileSync(jsFile, 'utf8');
    } catch {
      continue; // not emitted (e.g. excluded)
    }
    // Reasons name the file relative to the package, so no build-machine paths get published.
    const packageRelative = relative(dirname(srcDir), tsFile);
    const output = matchesBrowserSource(packageRelative, browser)
      ? removeEmbeddedInjections(jsSource, jsFile)
      : embedInjections(readFileSync(tsFile, 'utf8'), packageRelative, jsSource, jsFile);
    if (output !== jsSource) {
      writeFileSync(jsFile, output);
      changed.push(jsFile);
    }
  }

  return changed;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__fixtures__') yield* walk(path);
    } else {
      yield path;
    }
  }
}
