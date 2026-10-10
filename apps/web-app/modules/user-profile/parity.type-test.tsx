/**
 * Type guarantees of remembered state, once props, `<Form>` and instant visits against this app's routes — checked
 * by `tsc` (`pnpm typecheck`, `marmeon build`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the
 * comment above it is the message they get (read with the directive removed).
 */
import { Controller, once } from '@marmeon/http';
import { Form, Link, useForm, useRemember, type Placeholder } from '@marmeon/react';
import { expectTypeOf } from 'vitest';
import type { ListPeopleController } from './controllers/ListPeopleController.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

export function Remembered() {
  const [tab, setTab] = useRemember('links-tab', 'links' as 'links' | 'activity');
  expectTypeOf(tab).toEqualTypeOf<'links' | 'activity'>();
  setTab('activity');
  // Argument of type '"card_number"' is not assignable to parameter of type '"'card_number' looks sensitive (a token, a secret, a
  // card) — remembered state leaves it out unless you say so: useRemember('card_number', initial, { sensitive: true })"'.
  // @ts-expect-error
  useRemember('card_number', '');
  // Said so: kept (never a password).
  useRemember('card_number', '', { sensitive: true });
  // Argument of type '"password"' is not assignable to parameter of type '"'password' looks like a password — passwords are
  // never remembered: they stay in the field until the page is left"'.
  // @ts-expect-error
  useRemember('password', '', { sensitive: true });

  useForm('user-profile.update', { user: 1 }, { name: '', bio: '' }, { remember: true });
  useForm('user-profile.update', { user: 1 }, { name: '', bio: '' }, { remember: { key: 'profile-edit' } });
  // No overload matches this call. The last overload gave the following error. Type '"password"' is not assignable to type
  // '"password fields are never remembered — they stay in the field until the page is left"'. (No sensitive field here to name.)
  // @ts-expect-error
  useForm('auth.register.store', {}, { name: '', email: '', password: '', password_confirmation: '' }, { remember: { include: ['password'] } });

  // Params forgotten — "No overload matches this call. The last overload gave the following error. …
  // Type '{ name: string; bio: string; }' is not assignable to type '"'user-profile.update' takes route parameters — pass them
  // before the initial data: useForm('user-profile.update', params, initial)"'."
  // @ts-expect-error
  useForm('user-profile.update', { name: '', bio: '' });
  return null;
}

export class OnceController extends Controller {
  handle() {
    return this.view('user-profile/People', {
      countries: once(() => ['DE', 'GB']),
      // Type 'Map<string, number>' is not assignable to type 'Map<string, number> & "a once prop is kept by the browser as JSON —
      // its value must be plain data (no functions, Map, Set, bigint, undefined or promises inside)"'.
      // @ts-expect-error
      rates: once(() => new Map([['EUR', 1]])),
      // @ts-expect-error — a function inside: the same message.
      helpers: once(() => ({ format: (value: number) => String(value) })),
    });
  }
}

export function Forms() {
  return (
    <>
      <Form route="auth.tokens.store">
        {(form) => (
          <>
            <input {...form.field('name')} />
            <input type="checkbox" {...form.field('abilities[]')} value="users:read" />
            {/* Argument of type '"nmae"' is not assignable to parameter of type '"abilities" | "abilities[]" | "name"'. */}
            {/* @ts-expect-error */}
            <input {...form.field('nmae')} />
          </>
        )}
      </Form>
      {/* A GET route with a query schema: its fields are the query. */}
      <Form route="user-profile.people">{(form) => <input {...form.field('q')} />}</Form>
      {/* Type '"user-profile.show"' is not assignable to type '"'user-profile.show' is a GET route without a query schema — a form's
          fields would go into its URL; give its controller `static request = defineRequest({ query })`, or send it with a <Link>"'. */}
      {/* @ts-expect-error */}
      <Form route="user-profile.show" params={{ user: 1 }}>
        {null}
      </Form>
      {/* Property 'params' is missing in type … */}
      {/* @ts-expect-error */}
      <Form route="user-profile.update">{null}</Form>
    </>
  );
}

/** A placeholder takes what the controller declares (`declare readonly instant: { name: string }`). */
export const ProfilePlaceholder = (({ name }: { name: string }) => <h1>{name}</h1>) satisfies Placeholder<ShowUserProfileController>;
// Type '({ title }: { title: string; }) => Element' does not satisfy the expected type 'ComponentType<{ name: string; }>'. …
// Property 'title' is missing in type '{ name: string; }' but required in type '{ title: string; }'.
// @ts-expect-error
export const WrongPlaceholder = (({ title }: { title: string }) => <h1>{title}</h1>) satisfies Placeholder<ShowUserProfileController>;
export const PeoplePlaceholder = (() => <h1>People</h1>) satisfies Placeholder<ListPeopleController>;

export function Instant({ id, name }: { id: number; name: string }) {
  return (
    <>
      <Link route="user-profile.show" params={{ user: id }} instant={{ name }}>
        {name}
      </Link>
      <Link route="user-profile.people" instant>
        People
      </Link>
      {/* Object literal may only specify known properties, but 'nam' does not exist in type '{ name: string; }'. Did you mean to write 'name'? */}
      {/* @ts-expect-error */}
      <Link route="user-profile.show" params={{ user: id }} instant={{ nam: name }}>
        {name}
      </Link>
      {/* Type 'boolean' is not assignable to type '{ name: string; }'. — the profile's placeholder needs the name. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.show" params={{ user: id }} instant>
        {name}
      </Link>
      {/* Type 'true' is not assignable to type '"'auth.security' shows no placeholder — declare what it gets on its controller
          (`declare readonly instant: { … }`) and give its view one (`View.placeholder = …`)"'. */}
      {/* @ts-expect-error */}
      <Link route="auth.security" instant>
        Settings
      </Link>
    </>
  );
}
