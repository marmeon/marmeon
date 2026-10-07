/**
 * Type guarantees of live validation (E62) against this app's routes and request schemas — checked by `tsc` (`pnpm typecheck`,
 * `marmeon build`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the comment above it is the message
 * they get (read with the directive removed).
 */
import type { ContextOf } from '@marmeon/http';
import { useForm } from '@marmeon/react';
import { expectTypeOf } from 'vitest';
import type { RegisterRequest } from './controllers/RegisterController.ts';

export function Registration() {
  const form = useForm('auth.register.store', {}, { name: '', email: '', password: '', password_confirmation: '' }, { validate: { on: 'blur', fields: ['name', 'email'] } });
  form.validate('email');
  expectTypeOf(form.validating('name')).toEqualTypeOf<boolean>();

  // Argument of type '"emial"' is not assignable to parameter of type '"'emial' is not a field of this form — it has email, name"'.
  // @ts-expect-error
  form.validate('emial');
  // Argument of type '"password"' is not assignable to parameter of type '"'password' — password fields are never validated live —
  // they are checked when the form is sent"'.
  // @ts-expect-error
  form.validating('password');

  // No overload matches this call. The last overload gave the following error. Type '"password_confirmation"' is not assignable
  // to type '"email" | "name" | "password fields are never validated live — they are checked when the form is sent"'.
  // @ts-expect-error
  useForm('auth.register.store', {}, { name: '', email: '', password: '', password_confirmation: '' }, { validate: { fields: ['name', 'password_confirmation'] } });

  // No overload matches this call. The last overload gave the following error. Type '"keypress"' is not assignable to type
  // '"blur" | "change" | undefined'.
  // @ts-expect-error
  useForm('auth.register.store', {}, { name: '', email: '', password: '', password_confirmation: '' }, { validate: { on: 'keypress' } });

  // A route without a request schema has nothing to validate — the form's own message:
  // No overload matches this call. The last overload gave the following error. Argument of type '"auth.logout"' is not assignable
  // to parameter of type '"'auth.logout' has no request schema to type a form with — give its controller `static request =
  // defineRequest(…)`"'.
  // @ts-expect-error
  useForm('auth.logout', {}, {}, { validate: true });

  // A form by controller (`useForm<C>(initial)`) has no URL until it is sent — live validation needs its route:
  // Object literal may only specify known properties, and 'validate' does not exist in type 'FormOptions'.
  // @ts-expect-error
  useForm<{ name: string }>({ name: '' }, { validate: true });
  return null;
}

/** The schema built per request (it asks the database) types the body like a plain one. */
export function body(ctx: ContextOf<typeof RegisterRequest>) {
  expectTypeOf(ctx.body).toEqualTypeOf<{ name: string; email: string; password: string; password_confirmation: string }>();
}
