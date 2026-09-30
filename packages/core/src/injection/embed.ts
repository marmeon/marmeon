import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';
import { analyzeInjections, InjectionError, insertInjections, UNRESOLVABLE, type InjectionSite } from './analyze.ts';

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
  const jsClasses = new Map<string, Node>();
  const jsValues = new Set<string>();
  for (const statement of program.body as Node[]) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) jsValues.add(specifier.local.name);
    }
    const declaration =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;
    if (declaration?.type === 'ClassDeclaration' || declaration?.type === 'ClassExpression') {
      jsClasses.set(declaration.id?.name ?? 'default', declaration);
    }
    if (declaration?.type === 'ClassDeclaration' && declaration.id) jsValues.add(declaration.id.name);
    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        jsValues.add(declarator.id.name);
        if (declarator.init?.type === 'ClassExpression') jsClasses.set(declarator.id.name, declarator.init);
      }
    }
  }

  const jsSites: InjectionSite[] = [];
  for (const site of sites) {
    const node = jsClasses.get(site.className);
    if (!node) throw new InjectionError(`${jsFile}: compiled output has no class "${site.className}".`);
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
  return classNode.body.body.some(
    (member: Node) =>
      member.static &&
      (member.key?.name === 'inject' || (member.computed && source.slice(member.key.start, member.key.end).includes(UNRESOLVABLE))),
  );
}

export interface EmbedPackageOptions {
  /** TypeScript sources (tsconfig `rootDir`). */
  srcDir: string;
  /** Compiled output (tsconfig `outDir`). */
  outDir: string;
}

/** Runs {@link embedInjections} over a whole package. Returns the files that changed. */
export function embedPackageInjections({ srcDir, outDir }: EmbedPackageOptions): string[] {
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
    const output = embedInjections(readFileSync(tsFile, 'utf8'), packageRelative, jsSource, jsFile);
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
