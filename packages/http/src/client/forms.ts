import type { PageObject } from '../page.ts';

/**
 * The first validation message per field of a page — the server sends a list per field (the shared `errors` prop,
 * after it redirected back to the form); forms show the first. Empty when the page has none.
 */
export function firstErrors(page: PageObject): Record<string, string> {
  const errors = (page.props as { errors?: unknown }).errors;
  if (typeof errors !== 'object' || errors === null) return {};
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(errors)) {
    const first = Array.isArray(messages) ? messages[0] : messages;
    if (typeof first === 'string') result[field] = first;
  }
  return result;
}

/**
 * The fields of a form that differ from where it started — as paths: `name`, `address.city`, `links.0.url`. Leaves of
 * objects and arrays are compared one by one; an array that changed its length is dirty as a whole (and so are the items
 * that differ). Values compare as JSON would send them (a `Date` by its string); a `File` by identity.
 */
export function dirtyPaths(initial: unknown, current: unknown, prefix = ''): string[] {
  if (Object.is(initial, current)) return [];
  const plain = (value: unknown) => typeof value === 'object' && value !== null && !(value instanceof Blob) && !(value instanceof Date);
  if (!plain(initial) || !plain(current) || Array.isArray(initial) !== Array.isArray(current)) {
    return comparable(initial) === comparable(current) ? [] : [prefix];
  }
  const paths: string[] = [];
  if (Array.isArray(initial) && Array.isArray(current) && initial.length !== current.length) paths.push(prefix);
  const before = initial as Record<string, unknown>;
  const after = current as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    paths.push(...dirtyPaths(before[key], after[key], prefix === '' ? key : `${prefix}.${key}`));
  }
  return paths.filter((path) => path !== '' || prefix !== '');
}

/** Whether `path` (or anything under it) is among `dirty` — no path: anything at all. */
export function isDirtyPath(dirty: readonly string[], path?: string): boolean {
  if (path === undefined || path === '') return dirty.length > 0;
  return dirty.some((candidate) => candidate === path || candidate.startsWith(`${path}.`));
}

function comparable(value: unknown): unknown {
  if (value instanceof Blob) return value;
  return value === undefined ? undefined : JSON.stringify(value);
}

// -- Uncontrolled forms (`<Form>`): what a native form element holds ----------------------------------------------

/** The fields `<Form>` adds for browsers without JavaScript — never sent by a client-side submit (the header carries them). */
export const FORM_TOKEN_FIELD = '_token';
export const FORM_METHOD_FIELD = '_method';

/** Entries of a form, in document order: `[name, value]` — strings, or files. */
export type FormEntries = readonly (readonly [string, FormDataEntryValue])[];

/** A form field's name as a path into its data: `links[0][url]` → `links.0.url`, `abilities[]` → `abilities` (errors are keyed so). */
export function fieldPath(name: string): string {
  return name.replace(/\[\]$/, '').replace(/\[([^[\]]*)\]/g, '.$1').replace(/\.$/, '');
}

const KEY = /^([^[\]]+)((?:\[[^[\]]*\])*)$/;
type Tree = { [key: string]: Tree | FormDataEntryValue };

/**
 * A form's entries as the data the server would build from them (bracket notation, like the router): `user[name]` →
 * `{ user: { name } }`, `tags[]` → a list, `links[0][url]` → a list of objects. Later entries win, an empty file field is left
 * out, `__proto__` never becomes a key. The same data a submit without JavaScript sends.
 */
export function formObject(entries: Iterable<readonly [string, FormDataEntryValue]>): Record<string, unknown> {
  const root: Tree = Object.create(null);
  for (const [name, value] of entries) {
    if (typeof value !== 'string' && value.name === '' && value.size === 0) continue;
    const match = KEY.exec(name);
    const path = match ? [match[1]!, ...[...match[2]!.matchAll(/\[([^[\]]*)\]/g)].map((part) => part[1]!)] : [name];
    let node = root;
    for (let i = 0; i < path.length; i++) {
      const key = path[i] === '' ? String(Object.keys(node).filter((k) => /^\d+$/.test(k)).reduce((next, k) => Math.max(next, Number(k) + 1), 0)) : path[i]!;
      if (key === '__proto__') break;
      if (i === path.length - 1) {
        node[key] = value;
        break;
      }
      const child = node[key];
      node = node[key] = typeof child === 'object' && !(child instanceof Blob) ? child : Object.create(null);
    }
  }
  const finalize = (node: Tree | FormDataEntryValue): unknown => {
    if (typeof node === 'string' || node instanceof Blob) return node;
    const keys = Object.keys(node);
    if (keys.length > 0 && keys.every((key, index) => key === String(index))) return keys.map((key) => finalize(node[key]!));
    return Object.fromEntries(keys.map((key) => [key, finalize(node[key]!)]));
  };
  return finalize(root) as Record<string, unknown>;
}

/** The parts of a form control `<Form>` reads (a DOM element). */
interface Control {
  readonly name: string;
  readonly type: string;
  readonly disabled?: boolean;
  value: string;
  defaultValue?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  readonly options?: ArrayLike<{ value: string; selected: boolean; defaultSelected: boolean }>;
  readonly multiple?: boolean;
}

/** The named, enabled controls of a form — those whose values a submit would send. */
function controlsOf(form: { readonly elements: ArrayLike<unknown> }): Control[] {
  return Array.from(form.elements as ArrayLike<Control>).filter(
    (control) => typeof control.name === 'string' && control.name !== '' && !control.disabled && !['submit', 'button', 'reset', 'image', 'fieldset', 'output', 'object'].includes(control.type),
  );
}

/**
 * The entries a form starts with — its controls' defaults (`defaultValue`, `defaultChecked`, the options selected in the
 * markup), as `new FormData(form)` would give them right after a reset. What "dirty" compares against. Files: none.
 */
export function defaultFormEntries(form: { readonly elements: ArrayLike<unknown> }): [string, string][] {
  const entries: [string, string][] = [];
  for (const control of controlsOf(form)) {
    if (control.type === 'file') continue;
    if (control.type === 'checkbox' || control.type === 'radio') {
      if (control.defaultChecked) entries.push([control.name, control.value || 'on']);
    } else if (control.options && control.type.startsWith('select')) {
      const options = Array.from(control.options);
      const selected = options.filter((option) => option.defaultSelected);
      // A single select without a selected option starts on its first.
      for (const option of selected.length > 0 || control.multiple ? selected : options.slice(0, 1)) entries.push([control.name, option.value]);
    } else {
      entries.push([control.name, control.defaultValue ?? '']);
    }
  }
  return entries;
}

/** The entries of a form now, without files and without the no-JavaScript fields (`_token`, `_method`). */
export function formEntries(form: HTMLFormElement): [string, string][] {
  return [...new FormData(form)].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== FORM_TOKEN_FIELD && entry[0] !== FORM_METHOD_FIELD);
}

/** The same entries? (Order counts within a name, not between names.) */
export function sameEntries(a: readonly (readonly [string, string])[], b: readonly (readonly [string, string])[]): boolean {
  const key = (entries: readonly (readonly [string, string])[]) => JSON.stringify([...entries].map(([name, value]) => `${name}=${value}`).sort());
  return key(a) === key(b);
}

/**
 * Puts entries back into a form's controls — what was remembered: for each name in `names`, text-like controls get their
 * values in order, checkboxes and radios are checked when their value is there, options selected. Names not in `names` (left
 * out on purpose — sensitive) keep what they show.
 */
export function restoreFormEntries(form: { readonly elements: ArrayLike<unknown> }, entries: readonly (readonly [string, string])[], names: readonly string[]): void {
  const remaining = new Map<string, string[]>();
  for (const [name, value] of entries) remaining.set(name, [...(remaining.get(name) ?? []), value]);
  for (const control of controlsOf(form)) {
    if (!names.includes(control.name) || control.type === 'file') continue;
    const values = remaining.get(control.name) ?? [];
    if (control.type === 'checkbox' || control.type === 'radio') {
      control.checked = values.includes(control.value || 'on');
    } else if (control.options && control.type.startsWith('select')) {
      for (const option of Array.from(control.options)) option.selected = values.includes(option.value);
    } else if (values.length > 0) {
      control.value = values.shift()!;
    }
  }
}

/**
 * What a form control says about itself, apart from its name: `'never'` for a password or a one-time code, `'named'` for a
 * card detail (kept only when the form names the field), `undefined` for anything else.
 */
export function sensitiveControl(control: { readonly type: string; getAttribute(name: string): string | null }): 'never' | 'named' | undefined {
  const autocomplete = control.getAttribute('autocomplete')?.toLowerCase() ?? '';
  // `current-password`, `new-password`, `one-time-code`; the card details are `cc-number`, `cc-csc`, …
  return control.type === 'password' || /one-time-code|-password/.test(autocomplete) ? 'never' : autocomplete.includes('cc-') ? 'named' : undefined;
}
