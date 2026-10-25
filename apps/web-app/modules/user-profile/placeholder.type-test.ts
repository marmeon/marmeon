/**
 * Type guarantees of `app.placeholder(route, instant)` against this app's routes — checked by `tsc`, never run. Each
 * `@ts-expect-error` is a mistake an app developer makes; the comment above it is the message they get.
 */
import type { TestApp, TestMarkup } from '@marmeon/testing';

export async function Placeholders(app: TestApp): Promise<TestMarkup> {
  await app.placeholder('user-profile.show', { name: 'Ada' });
  await app.placeholder('user-profile.people', true);
  await app.placeholder('dashboard.show');
  // Expected 2 arguments, but got 1 — the profile's placeholder needs the name.
  // @ts-expect-error
  await app.placeholder('user-profile.show');
  // Object literal may only specify known properties, but 'nam' does not exist in type '{ name: string; }'.
  // @ts-expect-error
  await app.placeholder('user-profile.show', { nam: 'Ada' });
  // Type 'boolean' is not assignable to type '{ name: string; }' — the profile's placeholder needs the name.
  // @ts-expect-error
  await app.placeholder('user-profile.show', true);
  // Argument of type 'true' is not assignable to parameter of type '"'auth.security' shows no placeholder — declare what it gets
  // on its controller (`declare readonly instant: { … }`) and give its view one (`View.placeholder = …`)"'.
  // @ts-expect-error
  await app.placeholder('auth.security', true);
  // Argument of type '"user-profile.nope"' is not assignable to parameter of type …: a route that does not exist.
  // @ts-expect-error
  await app.placeholder('user-profile.nope');
  return (await app.placeholder('dashboard.show')).assertSee('Dashboard').assertDontSee('Members');
}
