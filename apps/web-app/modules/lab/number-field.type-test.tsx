/** Type guarantees of a number rule's form field and of a defaulted field — checked by `tsc` (`pnpm typecheck`), never run. */
import { defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { useForm, type FormHandle, type FormPart } from '@marmeon/react';
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
    rows: r.array(r.object({ size: r.integer(), note: r.string().default('') })),
  }),
});

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
) {
  const checked: true[] = [capacity, count, ratio, ids, startsAt, flag, limit, size, note, partIds];
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
  return [checked, direct];
}

export function initial() {
  const full = useForm<Resources>({
    count: 1,
    ratio: 1,
    resource_ids: [],
    flag: false,
    settings: { limit: 10, label: '' },
    rows: [],
  });
  // @ts-expect-error — a field with a default is present in the form, so it belongs in `initial`
  useForm<Resources>({ count: 1, ratio: 1, flag: false, settings: { limit: 10, label: '' }, rows: [] });
  // @ts-expect-error — also inside an object
  useForm<Resources>({ count: 1, ratio: 1, resource_ids: [], flag: false, settings: { label: '' }, rows: [] });
  // @ts-expect-error — a numeric string is not a number
  useForm<Resources>({ count: '1', ratio: 1, resource_ids: [], flag: false, settings: { limit: 10, label: '' }, rows: [] });
  return full;
}
