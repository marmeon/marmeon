import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { MessageError } from './catalog.ts';
import { MessageSyntaxError, parseMessage, type Part } from './format.ts';
import { isLanguageTag } from './locale.ts';

export type Tree = { readonly [key: string]: unknown };

export const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whose texts an app's file rewords: the namespace it lands in, and how errors name the owner. */
export interface TextOwner {
  readonly namespace: string;
  /** "the framework's texts" */
  readonly texts: string;
  /** "a text of the framework's" */
  readonly textOf: string;
}

export const FRAMEWORK: TextOwner = { namespace: 'marmeon', texts: "the framework's texts", textOf: "a text of the framework's" };

/** The owner of a package's texts, named by its package name and namespace. */
export const packageOwner = (name: string, namespace: string): TextOwner => ({ namespace, texts: `the texts of ${name}`, textOf: `a text of ${name}` });

/** The app's rewording and translations of one namespace's texts: `lang/<namespace>/<locale>.ts`, by locale tag. */
export async function overrideFiles(root: string, namespace: string): Promise<{ path: string; locale: string }[]> {
  const dir = join(root, 'lang', namespace);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: { path: string; locale: string }[] = [];
  for (const entry of entries) {
    const match = /^([^/]+)\.[jt]s$/.exec(entry.name);
    if (!entry.isFile() || !match || !isLanguageTag(match[1])) continue; // `fr.test.ts`, `fr.d.ts` are no language tags
    files.push({ path: join(dir, entry.name), locale: match[1] });
  }
  return files;
}

/** The dot paths of a message tree's texts (and, apart, of its groups). Anything that is neither is left to the catalog's own error. */
export function textsOf(tree: Tree, texts = new Map<string, string>(), groups = new Set<string>(), path = ''): { texts: Map<string, string>; groups: Set<string> } {
  for (const [key, value] of Object.entries(tree)) {
    const at = path ? `${path}.${key}` : key;
    if (typeof value === 'string') texts.set(at, value);
    else if (isTree(value)) {
      groups.add(at);
      textsOf(value, texts, groups, at);
    }
  }
  return { texts, groups };
}

/** The placeholder names of a message, nested ones included. */
function placeholderNames(parts: readonly Part[], names = new Set<string>()): Set<string> {
  for (const part of parts) {
    if (typeof part === 'string' || part.kind === 'pound') continue;
    names.add(part.name);
    if ('branches' in part) for (const branch of Object.values(part.branches)) placeholderNames(branch, names);
  }
  return names;
}

/**
 * Checks an app's `lang/<namespace>/<locale>.ts` against the English texts of its owner — every key must exist there, and each text
 * must keep the placeholders of the English one (a translation may reorder or leave out words, never the values a text is given).
 * Keys are checked against `source`, placeholders against `placeholderSource` (the same by default; `false` checks none, and a key it lacks is not checked). Syntax errors are the catalog's, when the merged messages are added.
 */
export function checkOverride(path: string, root: string, tree: Tree, source: Tree, owner: TextOwner, placeholderSource: Tree | false = source): void {
  const file = relative(root, path).replaceAll('\\', '/');
  const original = textsOf(source);
  const own = textsOf(tree);
  const placeholderTexts = placeholderSource === false ? undefined : textsOf(placeholderSource).texts;
  for (const group of own.groups) {
    if (original.groups.has(group)) continue;
    throw new MessageError(`[marmeon:S6] ${file} has the key ${group}, ${original.texts.has(group) ? `which is ${owner.textOf}, not a group` : `which ${owner.texts} do not have`}.`);
  }
  for (const [key, text] of own.texts) {
    if (!original.texts.has(key)) {
      throw new MessageError(`[marmeon:S6] ${file} has the key ${key}, which ${owner.texts} do not have${original.groups.has(key) ? ' (it is a group of texts, not a text)' : ''}.`);
    }
    const sourceText = placeholderTexts?.get(key);
    if (sourceText === undefined) continue;
    let kept: ReadonlySet<string>;
    try {
      kept = placeholderNames(parseMessage(text));
    } catch (error) {
      if (error instanceof MessageSyntaxError) throw new MessageError(`[marmeon:S5] Message ${owner.namespace}.${key} in ${path} is malformed: ${error.message.replace(/^\[marmeon:S5\] /, '')}`);
      throw error;
    }
    for (const name of placeholderNames(parseMessage(sourceText))) {
      if (!kept.has(name)) throw new MessageError(`[marmeon:S6] ${file} drops the placeholder {${name}} of ${key}.`);
    }
  }
}

/** `base` with `overrides` laid over it, key by key. */
export function mergeTexts(base: Tree, overrides: Tree): Tree {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] = isTree(current) && isTree(value) ? mergeTexts(current, value) : value;
  }
  return merged;
}
