// Type guarantees of a form's errors — keyed by every field path and '_' — checked by `tsc` (pnpm build / typecheck), never run.
import type { FormRenderState, FormState } from './index.ts';

interface Order {
  title: string;
  address: { city: string };
  items: { name: string }[];
  answers: Record<string, string>;
}

export function errorKeys(state: FormState<Order>, handle: FormRenderState<Order>) {
  const { errors } = state;
  const found = [
    errors.title,
    errors['address.city'],
    errors['items.0.name'],
    errors[`items.${3}.name`],
    errors['answers.company'],
    errors._,
    // @ts-expect-error — a typo in a nested path
    errors['adress.city'],
    // @ts-expect-error — a field the data does not have
    errors.missing,
    // @ts-expect-error — a path past the data's end
    errors['title.x'],
  ];
  state.clearErrors('address.city', '_');
  // @ts-expect-error — clearing a field the data does not have
  state.clearErrors('missing');
  handle.error('_');
  handle.error('items[0][name]');
  // @ts-expect-error — a typo in a nested name
  handle.error('adress[city]');
  return found;
}

/** A field component generic over its form's data, as apps write them: it reads and clears a top-level field by `keyof F & string`. */
export function clearOf<F>(form: FormState<F>, name: keyof F & string) {
  form.clearErrors(name);
  return form.errors[name];
}

interface Editor {
  sections: { title: string; fields: { guest_label: Record<string, string>; options: [string, { value: string }] }[] }[];
}

export function listPaths(state: FormState<Editor>) {
  const found = [
    errors6(state),
    // @ts-expect-error — a typo in a path through two lists
    state.errors['sections.0.fields.1.guest_lable.de'],
    // @ts-expect-error — a path past the title, which holds a string
    state.errors['sections.0.title.x'],
  ];
  state.clearErrors('sections.0.fields.1.guest_label.de', 'sections.0.fields.1.options.1.value');
  // @ts-expect-error — position 0 of the tuple holds a string
  state.clearErrors('sections.0.fields.1.options.0.value');
  // @ts-expect-error — the tuple has two positions
  state.clearErrors('sections.0.fields.1.options.7');
  // @ts-expect-error — clearing a path the data does not have
  state.clearErrors('sections.0.fields.1.missing');
  return found;
}

function errors6(state: FormState<Editor>) {
  return [state.errors['sections.0.fields.1.guest_label.de'], state.errors['sections.0.fields.1.options.0'], state.errors['sections.0.fields.1.options.1.value']];
}

interface Tuples {
  pair: readonly [string, { value: string }];
  maybe: [string, { value: string }?];
}

export function tuplePaths(state: FormState<Tuples>) {
  state.clearErrors('pair.0', 'pair.1.value', 'maybe.0', 'maybe.1.value');
  // @ts-expect-error — position 0 of a readonly tuple holds a string
  state.clearErrors('pair.0.value');
  // @ts-expect-error — a readonly tuple of two has no position 2
  state.clearErrors('pair.2');
  // @ts-expect-error — position 0 of a tuple with an optional element holds a string
  state.clearErrors('maybe.0.value');
  // @ts-expect-error — a tuple with an optional element has no position 2
  state.clearErrors('maybe.2');
}

interface Locked {
  pair: { value: string }[] & { length: 2 };
  none: [];
}

export function lockedPaths(state: FormState<Locked>) {
  state.clearErrors('pair.0', 'pair.1.value');
  // @ts-expect-error — not a field of the items
  state.clearErrors('pair.0.missing');
  // @ts-expect-error — an empty tuple has no positions
  state.clearErrors('none.0');
}

interface Levels {
  a: { b: { c: { d: { e: { f: { g: { h: { i: string } } } } } } } };
}

export function deepest(state: FormState<Levels>) {
  const found = [
    state.errors['a.b.c.d.e.f.g.h'],
    // @ts-expect-error — the ninth level is past the limit
    state.errors['a.b.c.d.e.f.g.h.i'],
    // @ts-expect-error — a typo at the eighth level
    state.errors['a.b.c.d.e.f.g.x'],
  ];
  state.clearErrors('a.b.c.d.e.f.g.h');
  // @ts-expect-error — the ninth level is past the limit
  state.clearErrors('a.b.c.d.e.f.g.h.i');
  // A deeper path is read through the errors as plain strings.
  found.push((state.errors as Partial<Record<string, string>>)['a.b.c.d.e.f.g.h.i']);
  return found;
}

interface TreeNode {
  name: string;
  children: TreeNode[];
}

/** A form whose data refers to itself: the paths stop a few steps into it instead of recursing without end (no TS2589). */
export function tree(state: FormState<TreeNode>) {
  state.clearErrors('children.0.name', 'children.0.children.0', 'children.0.children.0.name', 'children.0.children.0.children', 'children.0.children.0.children.0');
  // @ts-expect-error — a typo inside the recursion
  state.clearErrors('children.0.nam');
  // @ts-expect-error — past the fifth level each step back into the record counts three
  state.clearErrors('children.0.children.0.children.0.name');
  return state.errors['children.0.name'];
}

interface Category {
  name: string;
  a: string;
  b: string;
  c: string;
  d: string;
  e: string;
  parent: Category | null;
  children: Category[];
  sibling: Category;
}

/** Three references to the record itself stay cheap: this compiles without TS2589. */
export function category(state: FormState<Category>) {
  state.clearErrors('parent.name', 'sibling.sibling', 'children.0.e', 'parent.parent.parent.name', 'parent.parent.parent.parent.name', 'sibling.parent.children.0.b');
  // @ts-expect-error — a typo inside the recursion
  state.clearErrors('children.0.sibling.nam');
  return [state.errors['children.0.name'], state.errors['parent.parent'], state.errors['sibling.children.0']];
}

interface Optional {
  me?: Optional;
  label: string;
}

interface Weak {
  profile?: { name?: string; bio?: { name?: string; x?: { name?: string; y?: { name?: string } } } };
}

type Chain<T> = { name?: string; next?: T };

/** Plain nesting, also through optional fields, is not cut short by the rule for records that refer to themselves. */
export function throughOptionals(a: FormState<Optional>, b: FormState<Weak>, c: FormState<Chain<Chain<Chain<Chain<Chain<Chain<Chain<Chain<{ name?: string }>>>>>>>>>) {
  return [
    a.errors['me.me.me.me.label'],
    b.errors['profile.bio.x.y.name'],
    c.errors['next.next.next.next.next.next.next.name'],
  ];
}

interface UNode {
  name: string;
  next: UNode | { leaf: string };
}

/** A recursive type in a union with a plain branch still pays the re-entry cost. */
export function unionNode(state: FormState<UNode>) {
  state.clearErrors('next.name', 'next.next.next.name', 'next.next.next.next.next.name');
  // @ts-expect-error — past the fifth level each step back into the record counts three
  state.clearErrors('next.next.next.next.next.next.name');
  return [state.errors['next.leaf'], state.errors['next.next.next.next.next.next.leaf']];
}

export function widened(state: FormState<Levels>, path: string) {
  const wide: string | undefined = (state.errors as Partial<Record<string, string>>)[path];
  // @ts-expect-error — the widened lookup may be missing
  const sure: string = (state.errors as Partial<Record<string, string>>)[path];
  return [wide, sure];
}
