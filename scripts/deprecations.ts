/**
 * Every deprecation in a package's code: the `@deprecated` tags and the `deprecated()` calls. `check:source` (rule 10) holds
 * them to one form — a replacement, a docs link and the version that removes the API — so an app always sees the way forward.
 *
 * Each rule in full: CONTRIBUTING.md, "Rules over the source".
 */
import { oxc, PACKAGE_CODE, type SourceFile } from './source-files.ts';

export interface Deprecation {
  readonly path: string;
  readonly line: number;
  readonly kind: 'tag' | 'call';
  /** The `x.y` that removes the API; missing when the tag or the call does not say one. */
  readonly removeIn?: string;
  /** The first argument of a `deprecated()` call, when it is a string literal. */
  readonly id?: string;
  /** Whether all three arguments of a `deprecated()` call are string literals. */
  readonly literals?: boolean;
  /** A problem found while reading it, when it is not one of the forms below. */
  readonly problem?: string;
  /** The tag's text, or the call's source. */
  readonly text: string;
}

const REPLACEMENT = /\b[Uu]se (?:\{@link\s+[^}]+\}|`[^`]+`)/;
const DOCS_LINK = /\bdocs\/[a-z0-9-]+\.md#[a-z0-9-]+/;
const REMOVED_IN = /\bRemoved in (\d+\.\d+)\b/;
const ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const VERSION = /^\d+\.\d+$/;

/** The modules `deprecated()` comes from: the entry points of `@marmeon/core`, and a package's own copy next to the code. */
const DEPRECATION_SOURCE = /^(?:@marmeon\/core(?:\/deprecation)?|\.{1,2}\/(?:.*\/)?deprecation(?:\.[jt]s)?)$/;

/** The tags of a JSDoc comment named `deprecated`, each as its text to the next tag; `{@link …}` and the like do not start one. */
function deprecatedTags(comment: string): { text: string; lineIndex: number }[] {
  const body = comment.split('\n').map((line) => line.replace(/^\s*\*?\s*/, '')).join('\n');
  const starts: number[] = [];
  let depth = 0;
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (char === '{') depth++;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === '@' && depth === 0 && (at === 0 || /\s/.test(body[at - 1]!)) && /[a-z]/.test(body[at + 1] ?? '')) starts.push(at);
  }
  return starts.flatMap((at, index) => {
    const text = body.slice(at, starts[index + 1] ?? body.length);
    if (!/^@deprecated\b/.test(text)) return [];
    return [{ text: text.replace(/\s+/g, ' ').trim(), lineIndex: body.slice(0, at).split('\n').length - 1 }];
  });
}

/** Every `@deprecated` tag and `deprecated()` call in the packages' code. */
export function findDeprecations(files: Iterable<SourceFile>): Deprecation[] {
  const found: Deprecation[] = [];
  for (const { path, text } of files) {
    if (!PACKAGE_CODE.test(path) || !text.includes('deprecat')) continue;
    const { program, comments, errors } = oxc().parseSync(path, text);
    if (errors.length > 0) throw new Error(`${path}: oxc-parser cannot read it: ${errors[0]!.message}`);
    const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;

    for (const comment of comments) {
      if (comment.type !== 'Block' || !comment.value.startsWith('*')) continue;
      for (const { text: body, lineIndex } of deprecatedTags(comment.value)) {
        found.push({ path, line: lineOf(comment.start) + lineIndex, kind: 'tag', removeIn: REMOVED_IN.exec(body)?.[1], text: body });
      }
    }

    // The names `deprecated` goes by in this file: the import may rename it.
    const names = new Set(['deprecated']);
    for (const statement of (program as { body: { type: string; source?: { value: string }; specifiers?: { type: string; local: { name: string }; imported?: { name?: string; value?: string } }[]; start: number; end: number }[] }).body) {
      if (statement.type !== 'ImportDeclaration' || !DEPRECATION_SOURCE.test(statement.source!.value)) continue;
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.type === 'ImportSpecifier' && (specifier.imported?.name ?? specifier.imported?.value) === 'deprecated') names.add(specifier.local.name);
        if (specifier.type === 'ImportNamespaceSpecifier' && statement.source!.value !== '@marmeon/core') {
          found.push({ path, line: lineOf(statement.start), kind: 'call', text: text.slice(statement.start, statement.end).slice(0, 160), problem: 'import deprecated by name (import { deprecated }) so that its calls can be read' });
        }
      }
    }

    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (node === null || typeof node !== 'object') return;
      const call = node as { type?: string; start: number; end: number; callee?: { type?: string; name?: string; computed?: boolean; property?: { type?: string; name?: string; value?: unknown } }; arguments?: unknown[] };
      const callee = call.callee;
      const isDeprecated =
        call.type === 'CallExpression' &&
        ((callee?.type === 'Identifier' && names.has(callee.name!)) ||
          (callee?.type === 'MemberExpression' && (callee.property?.type === 'Identifier' ? !callee.computed && callee.property.name === 'deprecated' : callee.property?.value === 'deprecated')));
      if (isDeprecated) {
        const literal = (argument: unknown): string | undefined => {
          const { type, value, expressions, quasis } = (argument ?? {}) as { type?: string; value?: unknown; expressions?: unknown[]; quasis?: { value: { cooked: string } }[] };
          if (type === 'Literal' && typeof value === 'string') return value;
          if (type === 'TemplateLiteral' && expressions?.length === 0) return quasis![0]!.value.cooked;
          return undefined;
        };
        const args = call.arguments ?? [];
        const [id, , removeIn] = args.map(literal);
        found.push({
          path,
          line: lineOf(call.start),
          kind: 'call',
          id,
          removeIn,
          literals: args.length === 3 && args.every((argument) => literal(argument) !== undefined),
          text: text.slice(call.start, call.end).replace(/\s+/g, ' ').slice(0, 160),
        });
      }
      for (const [key, child] of Object.entries(node)) if (key !== 'parent') visit(child);
    };
    visit(program);
  }
  return found;
}

/**
 * Whether `removeIn` (`x.y`) comes after `version`: compared by major and minor, and a pre-release counts as its release — at
 * `0.4.0-rc.1` an API removed in `0.4` is due, so the removal happens before the first candidate.
 */
export function removalIsAfter(removeIn: string, version: string): boolean {
  const [major = 0, minor = 0] = removeIn.split('.').map(Number);
  const [currentMajor = 0, currentMinor = 0] = version.split('.').map(Number);
  return major !== currentMajor ? major > currentMajor : minor > currentMinor;
}

/** What is wrong with `found`, `path:line: text — why`; [] when every deprecation shows the way forward. */
export function deprecationProblems(found: readonly Deprecation[], currentVersion: string): string[] {
  const problems: string[] = [];
  const seen = new Map<string, Deprecation>();
  for (const deprecation of found) {
    const where = `${deprecation.path}:${deprecation.line}: ${deprecation.text.slice(0, 120)}`;
    const wrong: string[] = deprecation.problem ? [deprecation.problem] : [];
    if (deprecation.kind === 'tag') {
      if (!REPLACEMENT.test(deprecation.text)) wrong.push('name the replacement ("Use {@link x}" or "Use `x`")');
      if (!DOCS_LINK.test(deprecation.text)) wrong.push('link the docs (docs/<page>.md#<anchor>)');
      if (deprecation.removeIn === undefined) wrong.push('say when it goes ("Removed in x.y")');
    } else if (!deprecation.problem) {
      if (!deprecation.literals) wrong.push('give deprecated() three string literals (id, message, removeIn)');
      const segment = PACKAGE_CODE.exec(deprecation.path)?.[1];
      if (deprecation.id !== undefined) {
        if (!ID.test(deprecation.id)) wrong.push('the id is <package>.<name>, lower case');
        else if (deprecation.id.split('.')[0] !== segment) wrong.push(`the id starts with the package of the file (${segment})`);
        const first = seen.get(deprecation.id);
        if (first) wrong.push(`the id is taken already (${first.path}:${first.line})`);
        else seen.set(deprecation.id, deprecation);
      }
      if (deprecation.literals && (deprecation.removeIn === undefined || !VERSION.test(deprecation.removeIn))) wrong.push('removeIn is "major.minor"');
    }
    if (deprecation.removeIn !== undefined && VERSION.test(deprecation.removeIn)) {
      if (!removalIsAfter(deprecation.removeIn, currentVersion)) {
        wrong.push(`it is removed in ${deprecation.removeIn}, which is not after the current version ${currentVersion} — a typo, or overdue`);
      } else if (Number(currentVersion.split('.')[0]) >= 1 && !deprecation.removeIn.endsWith('.0')) {
        wrong.push(`from 1.0 on an API goes in a major release: Removed in ${Number(currentVersion.split('.')[0]) + 1}.0`);
      }
    }
    if (wrong.length > 0) problems.push(`${where} — ${wrong.join('; ')}`);
  }
  return problems;
}
