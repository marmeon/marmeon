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
