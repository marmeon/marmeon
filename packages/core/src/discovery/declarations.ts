import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseSync } from '../oxc.ts';
import { entryInside } from './contain.ts';
import { DiscoveryError } from './error.ts';
import type { PackageInfo } from './resolve.ts';

/** Levels of `export *` and re-exports the reader follows; a longer chain is a hostile or broken package, not a real one. */
const MAX_REEXPORT_DEPTH = 64;

/** The package a declaration file belongs to: every relative import is followed only inside its directory. */
type Owner = Pick<PackageInfo, 'name' | 'dir'>;

type Node = { type: string; start: number; end: number; [key: string]: any };

/** Where a symbol is declared. */
export interface Location {
  readonly file: string;
  readonly name: string;
}

export interface ParamInfo {
  /** `Clock` or `mail.Mailer`; undefined when the parameter cannot be injected. */
  readonly type: string | undefined;
  readonly optional: boolean;
  /** Source text of the parameter, for messages. */
  readonly text: string;
  readonly line: number;
}

export interface ImportInfo {
  readonly from: string;
  /** Imported name, `default`, or `*` for a namespace import. */
  readonly imported: string;
  readonly typeOnly: boolean;
}

export interface DeclarationFile {
  readonly file: string;
  /** Names that exist at runtime (classes, variables, functions). */
  readonly values: Set<string>;
  readonly classes: Map<string, readonly ParamInfo[]>;
  readonly imports: Map<string, ImportInfo>;
  /** Exported name -> declaration, following `export *` and re-exports. */
  readonly exports: Map<string, Location>;
}

/**
 * Reads `.d.ts` files — the types `tsc` ships with a package — with caching and cycle safety. A relative import is followed only
 * to a file inside the package (also by its real path), so a dependency cannot make discovery read files elsewhere on the disk.
 */
export class DeclarationReader {
  readonly #cache = new Map<string, DeclarationFile>();
  /** Files whose reading failed: asking again throws the same error at once, so a hostile chain is parsed once, not once per class. */
  readonly #failed = new Map<string, DiscoveryError>();

  read(file: string, owner: Owner): DeclarationFile {
    return this.#read(file, owner, 0);
  }

  #read(file: string, owner: Owner, depth: number): DeclarationFile {
    const cached = this.#cache.get(file);
    if (cached) return cached;
    const failed = this.#failed.get(file);
    if (failed) throw failed;
    if (depth > MAX_REEXPORT_DEPTH) {
      throw new DiscoveryError(`${owner.name} has re-exports nested deeper than ${MAX_REEXPORT_DEPTH} levels, so its types cannot be read.`);
    }

    const info: DeclarationFile = { file, values: new Set(), classes: new Map(), imports: new Map(), exports: new Map() };
    this.#cache.set(file, info); // before following re-exports, so cycles terminate
    try {
      this.#parse(file, owner, depth, info);
    } catch (error) {
      this.#cache.delete(file); // half read: a later read must not take it for complete
      if (error instanceof DiscoveryError) this.#failed.set(file, error);
      throw error;
    }
    return info;
  }

  #parse(file: string, owner: Owner, depth: number, info: DeclarationFile): void {
    const source = readFileSync(file, 'utf8');
    const { program } = parseSync(file, source);

    for (const node of program.body as Node[]) {
      switch (node.type) {
        case 'ImportDeclaration':
          for (const specifier of node.specifiers) {
            info.imports.set(specifier.local.name, {
              from: node.source.value,
              imported: specifier.type === 'ImportNamespaceSpecifier' ? '*' : (specifier.imported?.name ?? 'default'),
              typeOnly: node.importKind === 'type' || specifier.importKind === 'type',
            });
          }
          break;

        case 'ExportAllDeclaration': {
          const target = this.#relative(file, node.source.value, owner);
          if (target && !node.exported) {
            for (const [name, location] of this.#read(target, owner, depth + 1).exports) if (name !== 'default') info.exports.set(name, location);
          }
          break;
        }

        case 'ExportNamedDeclaration':
          if (node.source) {
            const target = this.#relative(file, node.source.value, owner);
            // `export type { Guards } from …` makes no value: a class exported so cannot be injected, there is nothing to import at runtime.
            if (target && node.exportKind !== 'type') {
              const targetExports = this.#read(target, owner, depth + 1).exports;
              for (const specifier of node.specifiers) {
                if (specifier.exportKind === 'type') continue;
                const location = targetExports.get(specifier.local.name ?? specifier.local.value);
                if (location) info.exports.set(specifier.exported.name ?? specifier.exported.value, location);
              }
            }
          } else if (!node.declaration) {
            for (const specifier of node.specifiers) {
              if (node.exportKind === 'type' || specifier.exportKind === 'type') continue;
              info.exports.set(specifier.exported.name ?? specifier.exported.value, { file, name: specifier.local.name });
            }
          } else {
            this.#declare(node.declaration, info, source, true);
          }
          break;

        case 'ExportDefaultDeclaration': {
          const declaration = node.declaration;
          if (declaration.type === 'ClassDeclaration' && declaration.id) {
            this.#declare(declaration, info, source, false);
            info.exports.set('default', { file, name: declaration.id.name });
          } else if (declaration.type === 'Identifier') {
            info.exports.set('default', { file, name: declaration.name });
          }
          break;
        }

        default:
          this.#declare(node, info, source, false);
      }
    }
  }

  #declare(declaration: Node, info: DeclarationFile, source: string, exported: boolean): void {
    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        info.values.add(declarator.id.name);
        if (exported) info.exports.set(declarator.id.name, { file: info.file, name: declarator.id.name });
      }
    } else if (declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction') {
      info.values.add(declaration.id.name);
      if (exported) info.exports.set(declaration.id.name, { file: info.file, name: declaration.id.name });
    } else if (declaration.type === 'ClassDeclaration' && declaration.id) {
      const name: string = declaration.id.name;
      info.values.add(name);
      if (exported) info.exports.set(name, { file: info.file, name });
      const ctor = declaration.body.body.find((member: Node) => member.kind === 'constructor');
      info.classes.set(name, (ctor?.value.params ?? []).map((param: Node) => paramInfo(param, source)));
    }
  }

  /** `./x.js` → `./x.d.ts` (also `.mjs` → `.d.mts`, extensionless → `.d.ts` or `/index.d.ts`). */
  #relative(fromFile: string, specifier: string, owner: Owner): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const base = resolve(dirname(fromFile), specifier);
    const candidates = /\.m?[jt]s$/.test(base)
      ? [base.replace(/\.m?[jt]s$/, (ext) => (ext.startsWith('.m') ? '.d.mts' : '.d.ts'))]
      : [`${base}.d.ts`, `${base}/index.d.ts`];
    // `..` or `./` names the package's own root: the candidate above it lies outside, `index.d.ts` inside is the one meant.
    let outside = false;
    for (const candidate of candidates) {
      if (!entryInside(owner.dir, candidate)) {
        outside = true;
        continue;
      }
      if (existsSync(candidate)) return candidate;
    }
    if (outside) throw new DiscoveryError(`${owner.name} imports "${specifier}" in its types, which lies outside the package.`);
    return undefined;
  }

  /** Resolves a relative import of `fromFile` to the declaration file it points at. */
  relativeTarget(fromFile: string, specifier: string, owner: Owner): string | undefined {
    return this.#relative(fromFile, specifier, owner);
  }
}

function paramInfo(param: Node, source: string): ParamInfo {
  const type: Node | undefined = param.typeAnnotation?.typeAnnotation;
  return {
    type:
      param.type !== 'RestElement' && type?.type === 'TSTypeReference'
        ? source.slice(type.typeName.start, type.typeName.end)
        : undefined,
    optional: Boolean(param.optional) || param.type === 'AssignmentPattern',
    text: source.slice(param.start, param.end),
    line: source.slice(0, param.start).split('\n').length,
  };
}
