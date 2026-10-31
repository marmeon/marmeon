/** Type guarantees of a boolean rule's form field — checked by `tsc` (`pnpm typecheck`), never run. */
import { defineRequest, type ContextOf, type FormOf } from '@marmeon/http';
import { rules as r, type BooleanInput } from '@marmeon/validation';
import { useAction, type FieldPath, type FormHandle, type FormPart, type RouteFormFields } from '@marmeon/react';
import { LabController } from './controllers/ShowLabPageController.ts';
import type { UpdateGuestLabController } from './controllers/GuestLabController.ts';

const Request = defineRequest({
  schema: r.object({
    agree: r.boolean(),
    news: r.boolean().optional(),
    beta: r.boolean().nullable(),
    flag: r.boolean().default(false),
    terms: r.accepted(),
    name: r.string(),
    links: r.array(r.object({ url: r.string(), public: r.boolean() })),
    address: r.object({ shown: r.boolean() }),
  }),
});

class Settings extends LabController {
  static request = Request;

  handle(_ctx: ContextOf<typeof Request>) {
    return this.redirect('/lab');
  }
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export function booleans(
  form: FormHandle<Settings>,
  guest: FormHandle<UpdateGuestLabController>,
  part: FormPart<Settings, 'agree'>,
  direct: FormHandle<{ x: BooleanInput }>,
  // What the rules take stays what `useForm` maps: the copy in the react package must not drift.
  rule: Equal<FormOf<Settings>['agree'], BooleanInput>,
  agree: Equal<typeof form.data.agree, boolean>,
  news: Equal<typeof form.data.news, boolean | undefined>,
  beta: Equal<typeof form.data.beta, boolean | null>,
  flag: Equal<typeof form.data.flag, boolean>,
  terms: Equal<typeof form.data.terms, boolean>,
  coming: Equal<typeof guest.data.coming, boolean>,
  partAgree: Equal<typeof part.data.agree, boolean>,
  given: Equal<typeof direct.data.x, BooleanInput>,
  nested: Equal<typeof form.data.links[number]['public'], boolean>,
  object: Equal<typeof form.data.address.shown, boolean>,
  untouched: Equal<typeof form.data.links[number]['url'], string>,
  paths: Equal<Parameters<typeof form.isDirty>[0], FieldPath<FormOf<Settings>> | undefined>,
) {
  const checked: true[] = [rule, agree, news, beta, flag, terms, coming, partAgree, given, nested, object, untouched, paths];
  form.set('agree', true);
  form.set('terms', false);
  form.set('news', undefined);
  form.set('beta', null);
  form.set('links', [{ url: 'x', public: true }]);
  void form.errors['links.0.public'];
  // @ts-expect-error — a checkbox's state is a boolean, not what a browser posts
  form.set('agree', 'on');
  // @ts-expect-error — nor a number
  form.set('agree', 1);
  // @ts-expect-error — a boolean inside a list is a boolean too
  form.set('links', [{ url: 'x', public: 'on' }]);
  // @ts-expect-error — a string field is not a boolean
  form.set('name', true);
  // @ts-expect-error — and holds no boolean
  const name: boolean = form.data.name;
  // A direct type is the app's own: left as it is.
  direct.set('x', 'on');
  return [checked, name];
}

export function actions() {
  const save = useAction('auth.login.store');
  void save.submit({ data: { email: 'ada@example.test', password: 'x', remember: true } });
  // @ts-expect-error — an action's data is typed like a form's
  void save.submit({ data: { email: 'ada@example.test', password: 'x', remember: 'on' } });
}

export function route(fields: RouteFormFields<'auth.login.store'>, remember: Equal<typeof fields.remember, boolean>) {
  const checked: true = remember;
  return checked;
}
