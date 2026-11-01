/** Type guarantees of a number rule's form field and of a defaulted field — checked by `tsc` (`pnpm typecheck`), never run. */
import { defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { useAction, useForm, type FormHandle, type FormPart } from '@marmeon/react';
import { LabController } from './controllers/ShowLabPageController.ts';

const Request = defineRequest({
  schema: r.object({
    capacity: r.integer().nullable().optional(),
    count: r.integer(),
    ratio: r.number().default(1),
    resource_ids: r.array(r.integer()).default([]),
    starts_at: r.localDateTime('Europe/Berlin').optional(),
    flag: r.boolean(),
    settings: r.object({ limit: r.integer().default(10), label: r.string() }),
    contact: r.union([r.object({ kind: r.literal('mail'), address: r.string(), copies: r.integer().default(1) }), r.object({ kind: r.literal('post'), street: r.string() })]),
    rows: r.array(r.object({ size: r.integer(), note: r.string().default('') })),
  }),
});

const Transformed = defineRequest({
  schema: r.object({
    contact: r.union([
      r.object({ kind: r.literal('mail'), code: r.string().transform((value) => Number(value)), copies: r.integer().default(1) }),
      r.object({ kind: r.literal('post'), street: r.string() }),
    ]),
  }),
});

const RootUnion = defineRequest({
  schema: r.union([
    r.object({ kind: r.literal('mail'), address: r.string(), copies: r.integer().default(1) }),
    r.object({ kind: r.literal('post'), street: r.string() }),
  ]),
});

const Tagged = defineRequest({
  schema: r.union([
    r.object({ kind: r.literal('mail').default('mail'), copies: r.integer().default(1) }),
    r.object({ kind: r.literal('post'), street: r.string() }),
  ]),
});

const Untagged = defineRequest({
  schema: r.union([r.object({ a: r.string() }), r.object({ b: r.integer().default(1) })]),
});

class TaggedForm extends LabController {
  static request = Tagged;

  handle(_ctx: ContextOf<typeof Tagged>) {
    return this.redirect('/lab');
  }
}

class UntaggedForm extends LabController {
  static request = Untagged;

  handle(_ctx: ContextOf<typeof Untagged>) {
    return this.redirect('/lab');
  }
}

class Transforms extends LabController {
  static request = Transformed;

  handle(_ctx: ContextOf<typeof Transformed>) {
    return this.redirect('/lab');
  }
}

class Variants extends LabController {
  static request = RootUnion;

  handle(_ctx: ContextOf<typeof RootUnion>) {
    return this.redirect('/lab');
  }
}

class Resources extends LabController {
  static request = Request;

  handle(_ctx: ContextOf<typeof Request>) {
    return this.redirect('/lab');
  }
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export function numbers(
  form: FormHandle<Resources>,
  part: FormPart<Resources, 'resource_ids' | 'count'>,
  capacity: Equal<typeof form.data.capacity, number | '' | null | undefined>,
  count: Equal<typeof form.data.count, number>,
  ratio: Equal<typeof form.data.ratio, number | ''>,
  ids: Equal<typeof form.data.resource_ids, number[]>,
  startsAt: Equal<typeof form.data.starts_at, string | undefined>,
  flag: Equal<typeof form.data.flag, boolean>,
  limit: Equal<typeof form.data.settings.limit, number | ''>,
  size: Equal<typeof form.data.rows[number]['size'], number>,
  note: Equal<typeof form.data.rows[number]['note'], string>,
  partIds: Equal<typeof part.data.resource_ids, number[]>,
  copies: Equal<Extract<typeof form.data.contact, { kind: 'mail' }>['copies'], number | ''>,
) {
  const checked: true[] = [capacity, count, ratio, ids, startsAt, flag, limit, size, note, partIds, copies];
  const direct: number[] = form.data.resource_ids;
  form.set('capacity', '');
  form.set('capacity', null);
  form.set('capacity', 3);
  form.set('starts_at', '');
  form.set('ratio', '');
  // @ts-expect-error — a numeric string is what a browser posts, not what the form holds
  form.set('capacity', '3');
  // @ts-expect-error — a required number has no empty state
  form.set('count', '');
  // @ts-expect-error — a list of numbers holds numbers
  form.set('resource_ids', ['1']);
  // The number input the forms page shows.
  const input = (
    <input type="number" value={form.data.capacity ?? ''} onChange={(event) => form.set('capacity', event.target.value === '' ? '' : event.target.valueAsNumber)} />
  );
  return [checked, direct, input];
}

export function initial() {
  const full = useForm<Resources>({
    count: 1,
    ratio: 1,
    resource_ids: [],
    flag: false,
    settings: { limit: 10, label: '' },
    contact: { kind: 'post', street: '' },
    rows: [],
  });
  // @ts-expect-error — a field with a default is present in the form, so it belongs in `initial`
  useForm<Resources>({ count: 1, ratio: 1, flag: false, settings: { limit: 10, label: '' }, contact: { kind: 'post', street: '' }, rows: [] });
  // @ts-expect-error — also inside an object
  useForm<Resources>({ count: 1, ratio: 1, resource_ids: [], flag: false, settings: { label: '' }, contact: { kind: 'post', street: '' }, rows: [] });
  // @ts-expect-error — a numeric string is not a number
  useForm<Resources>({ count: '1', ratio: 1, resource_ids: [], flag: false, settings: { limit: 10, label: '' }, contact: { kind: 'post', street: '' }, rows: [] });
  return full;
}

export function unions(
  transformed: FormHandle<Transforms>,
  root: FormHandle<Variants>,
  copies: Equal<Extract<typeof transformed.data.contact, { kind: 'mail' }>['copies'], number | ''>,
  code: Equal<Extract<typeof transformed.data.contact, { kind: 'mail' }>['code'], string>,
  rootCopies: Equal<Extract<typeof root.data, { kind: 'mail' }>['copies'], number | ''>,
  street: Equal<Extract<typeof root.data, { kind: 'post' }>['street'], string>,
  withTag: FormHandle<TaggedForm>,
  withoutTag: FormHandle<UntaggedForm>,
  tagged: Equal<Extract<typeof withTag.data, { copies: unknown }>['copies'], number | ''>,
  untagged: Equal<Extract<typeof withoutTag.data, { b: unknown }>['b'], number | ''>,
) {
  const checked: true[] = [copies, code, rootCopies, street, tagged, untagged];
  // @ts-expect-error — the variant's `copies` is present in the form, so it belongs in `initial`
  useForm<Variants>({ kind: 'mail', address: '' });
  useForm<Variants>({ kind: 'mail', address: '', copies: 1 });
  useForm<Variants>({ kind: 'post', street: '' });
  return checked;
}

declare module '@marmeon/router' {
  interface Routes {
    'lab.resources.store': { method: 'post'; path: '/lab/resources'; controller: typeof Resources };
  }
}

/** The calls of an action go back into `submit()` as its data — also with an optional number, which a route form's row holds as `''`. */
export function resubmit() {
  const save = useAction('lab.resources.store');
  const first = save.submissions[0];
  if (first) void save.submit({ data: first.input });
  return null;
}
