/** What the API checks share to read imports: the files that are no source, test and shipped paths, and the imports and namespace uses of a file. */

export interface Import {
  readonly specifier: string;
  /** The exported names the statement takes; `undefined` for the entry as a whole. */
  readonly names: readonly string[] | undefined;
  /** The local name of `import * as ns from 'x'` and `const ns = await import('x')`: its uses show which names are taken. */
  readonly namespace?: string;
}

/** `import … from 'x'` and `export … from 'x'`, over several lines too. The clause has no `=`, quote or bracket: prose and code in between do not match. */
const STATEMENT = /\b(?:import|export)\s+(?:type\s+)?([\w$\s{},*]*?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g;
/** `import('x')`, with the member when it is read directly: `import('x').Foo`. */
const DYNAMIC = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)(?:\.([\w$]+))?/g;

/** `const { a, b: c } = await import('x')` and `= require('x')`: the names are taken from the module like a named import. */
const DESTRUCTURED = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\(\s*(['"])([^'"\n]+)\2\s*\)/g;
/** `require('x')`, with the member when it is read directly. */
const REQUIRE = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)(?:\.([\w$]+))?/g;
/** Files that are no source of ours: build output, installed packages, what the framework generates. */
export const NOT_SOURCE = /(^|\/)(?:dist|node_modules|\.marmeon)\//;

/** The name a `{ … }` item takes from the module: `type A as B` is `A`. */
export function importedName(part: string): string {
  return part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
}

/** The imports and re-exports in a file's text (a Markdown page's code blocks included). */
export function importsOf(text: string): Import[] {
  const found: Import[] = [];
  for (const match of text.matchAll(STATEMENT)) {
    const clause = match[1]!.trim();
    const specifier = match[3]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    const names = braces ? braces[1]!.split(',').map(importedName).filter((name) => name !== '') : [];
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    const namespace = match[0].startsWith('import') ? /^\*\s*as\s+([\w$]+)$/.exec(outside)?.[1] : undefined;
    if (outside.startsWith('*')) found.push({ specifier, names: undefined, ...(namespace !== undefined && { namespace }) });
    else if (/^[\w$]+$/.test(outside)) names.push('default');
    if (names.length > 0) found.push({ specifier, names });
  }
  // A destructured import is read as names; what is left of the text is checked for whole and member imports.
  const rest = text.replace(DESTRUCTURED, (_, clause: string, _quote: string, specifier: string) => {
    // `a: b` and `a = 1` take `a`; a `...rest` or a computed key takes the module as a whole.
    const parts = clause.split(',').map((part) => part.trim().split(/\s*[:=]\s*/)[0]!.trim()).filter((part) => part !== '');
    const whole = parts.some((part) => !/^[\w$]+$/.test(part));
    found.push({ specifier, names: whole || parts.length === 0 ? undefined : parts });
    return '';
  });
  for (const regexp of [DYNAMIC, REQUIRE]) {
    for (const match of rest.matchAll(regexp)) {
      const namespace = match[3] ? undefined : /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?$/.exec(rest.slice(0, match.index))?.[1];
      found.push({ specifier: match[2]!, names: match[3] ? [match[3]] : undefined, ...(namespace !== undefined && { namespace }) });
    }
  }
  return found;
}

export interface NamespaceUse {
  /** The members read as `ns.Name` and the names taken by `const { A } = ns`. */
  readonly names: ReadonlySet<string>;
  /** `ns` is used in another way (passed on, spread, `ns[expr]`): the names it provides are not known. */
  readonly whole: boolean;
}

/** How a file uses the namespace `ns` it imported: named members, or as a whole. Any other occurrence of `ns` counts as a whole use. */
export function namespaceUseOf(source: string, ns: string): NamespaceUse {
  const text = source.replace(/(['"])[^'"\n]*\1/g, "''"); // a module specifier may contain the name: '@marmeon/demo'
  const names = new Set<string>();
  // Not a member of something else (`a.ns`), but a spread (`...ns`) is the namespace itself.
  const standalone = `(?<![\\w$])(?<!(?<!\\.)\\.)${ns.replaceAll('$', '\\$')}(?![\\w$])`;
  let accounted = 1; // the declaration
  let whole = false;
  for (const match of text.matchAll(new RegExp(`${standalone}\\??\\.([\\w$]+)`, 'g'))) {
    names.add(match[1]!);
    accounted += 1;
  }
  for (const match of text.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*${standalone}`, 'g'))) {
    // `a: b` and `a = 1` take `a`; a `...rest` or a computed key takes the namespace as a whole.
    const parts = match[1]!.split(',').map((part) => part.trim().split(/\s*[:=]\s*/)[0]!.trim()).filter((part) => part !== '');
    if (parts.some((part) => !/^[\w$]+$/.test(part))) whole = true;
    for (const part of parts) names.add(part);
    accounted += 1;
  }
  const occurrences = [...text.matchAll(new RegExp(standalone, 'g'))].length;
  return { names, whole: whole || names.size === 0 || occurrences > accounted };
}

export const TEST_FILE = /\.test\.|\.type-test\.|(^|\/)__fixtures__\//;
export const SHIPPED = /^packages\/[^/]+\/(?:stubs|template)\//;
