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
  /** Exported name -> its declaration, following `export *` and re-exports; only names located at a declaration. */
  readonly exports: Map<string, Location>;
  /** Every name exported as a value, located or not: a name re-exported from another package has no location. */
  readonly names: Set<string>;
  /** `export *` of another package or of a file the reader cannot follow, directly or through a file it re-exports with `export *`: the file may export any name. */
  opaque: boolean;
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

    const info: DeclarationFile = { file, values: new Set(), classes: new Map(), imports: new Map(), exports: new Map(), names: new Set(), opaque: false };
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
    const body = program.body as Node[];

    // Every import first: an export may stand above the import it names.
    for (const node of body) {
      if (node.type !== 'ImportDeclaration') continue;
      for (const specifier of node.specifiers) {
        info.imports.set(specifier.local.name, {
          from: node.source.value,
          imported:
            specifier.type === 'ImportNamespaceSpecifier'
              ? '*'
              : specifier.type === 'ImportDefaultSpecifier'
                ? 'default'
                : (specifier.imported.name ?? specifier.imported.value),
          typeOnly: node.importKind === 'type' || specifier.importKind === 'type',
        });
      }
    }

    /** Names the file exports itself: they overwrite a name that `export *` brought, and `export *` never overwrites them. */
    const explicit = new Set<string>();
    /** An export of this file; without a location the name is a value the reader does not follow to its declaration. */
    const exportName = (name: string, location?: Location): void => {
      explicit.add(name);
      info.names.add(name);
      if (location) info.exports.set(name, location);
      else info.exports.delete(name);
    };
    /** The export `name` of a file read by a relative path: located, or a value of it that has no location, or no value at all. */
    const exportFrom = (exported: string, target: DeclarationFile, name: string): void => {
      const location = target.exports.get(name);
      if (location) exportName(exported, location);
      else if (target.names.has(name) || target.opaque) exportName(exported);
    };

    for (const node of body) {
      switch (node.type) {
        case 'ExportAllDeclaration': {
          if (node.exportKind === 'type') break; // `export type * from …` makes no value
          const specifier: string = node.source.value;
          if (node.exported) {
            exportName(node.exported.name ?? node.exported.value); // a namespace: not read, not followed
            break;
          }
          const target = specifier.startsWith('.') ? this.#relative(file, specifier, owner) : undefined;
          if (!target) {
            info.opaque = true; // another package, or a file the reader cannot follow: any name may come from it
            break;
          }
          const read = this.#read(target, owner, depth + 1);
          if (read.opaque) info.opaque = true;
          for (const name of read.names) {
            if (name === 'default' || explicit.has(name)) continue;
            info.names.add(name);
            const location = read.exports.get(name);
            if (location) info.exports.set(name, location);
            else info.exports.delete(name);
          }
          break;
        }

        case 'ExportNamedDeclaration':
          if (node.source) {
            // `export type { Guards } from …` makes no value: a class exported so cannot be injected, there is nothing to import at runtime.
            if (node.exportKind === 'type') break;
            const specifier: string = node.source.value;
            const target = specifier.startsWith('.') ? this.#relative(file, specifier, owner) : undefined;
            const read = target && this.#read(target, owner, depth + 1);
            for (const item of node.specifiers) {
              if (item.exportKind === 'type') continue;
              const exported = item.exported.name ?? item.exported.value;
              if (read) exportFrom(exported, read, item.local.name ?? item.local.value);
              else exportName(exported); // another package, or a file the reader cannot follow: not followed
            }
          } else if (!node.declaration) {
            for (const item of node.specifiers) {
              if (node.exportKind === 'type' || item.exportKind === 'type') continue;
              this.#exportLocal(file, owner, depth, info, item.exported.name ?? item.exported.value, item.local.name, exportName, exportFrom);
            }
          } else {
            this.#declare(node.declaration, info, source, (name) => exportName(name, { file, name }));
          }
          break;

        case 'ExportDefaultDeclaration': {
          const declaration = node.declaration;
          if (declaration.type === 'ClassDeclaration') {
            if (declaration.id) {
              this.#declare(declaration, info, source);
              exportName('default', { file, name: declaration.id.name });
            } else {
              exportName('default'); // a class without a name has no location to give
            }
          } else if (declaration.type === 'Identifier') {
            this.#exportLocal(file, owner, depth, info, 'default', declaration.name, exportName, exportFrom);
          }
          break;
        }

        case 'ImportDeclaration':
          break;

        default:
          this.#declare(node, info, source);
      }
    }
  }

  /** `export { local as exported }` without a source: a declaration of this file, or an import exported again. */
  #exportLocal(
    file: string,
    owner: Owner,
    depth: number,
    info: DeclarationFile,
    exported: string,
    local: string,
    exportName: (name: string, location?: Location) => void,
    exportFrom: (exported: string, target: DeclarationFile, name: string) => void,
  ): void {
    const imported = info.imports.get(local);
    if (!imported) return exportName(exported, { file, name: local });
    if (imported.typeOnly) return; // an `import type` exported again makes no value, like `export type`
    if (imported.imported === '*' || !imported.from.startsWith('.')) return exportName(exported); // a namespace or another package: not followed
    const target = this.#relative(file, imported.from, owner);
    if (target) exportFrom(exported, this.#read(target, owner, depth + 1), imported.imported);
    else exportName(exported); // a file the reader cannot follow (no declaration file): not followed
  }

  #declare(declaration: Node, info: DeclarationFile, source: string, onExport?: (name: string) => void): void {
    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        info.values.add(declarator.id.name);
        onExport?.(declarator.id.name);
      }
    } else if (declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction') {
      info.values.add(declaration.id.name);
      onExport?.(declaration.id.name);
    } else if (declaration.type === 'ClassDeclaration' && declaration.id) {
      const name: string = declaration.id.name;
      info.values.add(name);
      onExport?.(name);
      const ctor = declaration.body.body.find((member: Node) => member.kind === 'constructor');
      info.classes.set(name, (ctor?.value.params ?? []).map((param: Node) => paramInfo(param, source)));
    }
  }

  /** `./x.js` → `./x.d.ts` (also `.mjs` → `.d.mts`, `.cjs` → `.d.cts`, extensionless → `.d.ts` or `/index.d.ts`). */
  #relative(fromFile: string, specifier: string, owner: Owner): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const base = resolve(dirname(fromFile), specifier);
    const candidates = /\.[cm]?[jt]s$/.test(base)
      ? [base.replace(/\.([cm]?)[jt]s$/, (_, kind: string) => `.d.${kind}ts`)]
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
