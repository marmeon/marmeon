// Type guarantees of FormPart — a component that shows some fields of more than one form — checked by `tsc`, never run.
import type { Form, FormPart, RouteForm } from './use-form.ts';

interface Create {
  title: string;
  body: string;
  tags: string[];
  address: { city: string };
}

interface Edit {
  title: string;
  body: string;
  published: boolean;
}

interface Retyped {
  title: number;
  body: string;
}

type Fields = FormPart<Create, 'title' | 'body'>;

export function parts(create: Form<Create>, edit: Form<Edit>, route: RouteForm<Edit>, retyped: Form<Retyped>, only: Form<{ title: string }>) {
  const assigned: Fields[] = [create, edit, route];
  // @ts-expect-error — a field with another type in this form
  assigned.push(retyped);
  // @ts-expect-error — a form without the part's `body`
  assigned.push(only);
  return assigned;
}

export function inside(part: Fields) {
  part.set('title', 'x');
  part.errors.title;
  part.errors._;
  part.clearErrors('body', '_');
  part.reset('title');
  // @ts-expect-error — setData would replace the data of the whole form
  part.setData({ title: 'x', body: 'y' });
  part.isDirty('body');
  // @ts-expect-error — a value of the wrong type
  part.set('title', 1);
  // @ts-expect-error — a field outside the part
  part.set('tags', []);
  // @ts-expect-error — errors are keyed by the part's fields only
  part.errors.tags;
  // @ts-expect-error — clearing a field outside the part
  part.clearErrors('published');
  // @ts-expect-error — the part's data has no other field
  part.data.tags;
}

// @ts-expect-error — a field the form does not have
export type Missing = FormPart<Create, 'nope'>;

export type OfFields = FormPart<{ title: string; body: string }, 'title'>;
