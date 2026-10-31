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
  // @ts-expect-error — clearing a path the data does not have
  state.clearErrors('sections.0.fields.1.missing');
  return found;
}

function errors6(state: FormState<Editor>) {
  return [state.errors['sections.0.fields.1.guest_label.de'], state.errors['sections.0.fields.1.options.0'], state.errors['sections.0.fields.1.options.1.value']];
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
  // A deeper path is read as a string key.
  found.push(state.errors['a.b.c.d.e.f.g.h.i' as never]);
  return found;
}

interface TreeNode {
  name: string;
  children: TreeNode[];
}

/** A form whose data refers to itself: the paths stop after a few steps into it instead of recursing without end (no TS2589). */
export function tree(state: FormState<TreeNode>) {
  state.clearErrors('children.0.name', 'children.0.children.0');
  // @ts-expect-error — a typo inside the recursion
  state.clearErrors('children.0.nam');
  // @ts-expect-error — the path stops a few steps into the record itself
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
  state.clearErrors('parent.name', 'sibling.sibling', 'children.0.e');
  // @ts-expect-error — a typo inside the recursion
  state.clearErrors('children.0.sibling.nam');
  return [state.errors['children.0.name'], state.errors['parent.parent'], state.errors['sibling.children.0']];
}
