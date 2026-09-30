import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { HttpError } from './errors.ts';
import { defineRequest, ValidationError, type ContextOf, type FormOf, type Validated } from './request-definition.ts';
import { Route } from './route.ts';
import { defineRoutes, Router } from './router.ts';
import type { EmptyObject, HttpContext, Next } from './types.ts';

interface User {
  id: string;
}
interface AuthState {
  user: User;
}

class Authenticate {
  handle(ctx: HttpContext, next: Next<AuthState>) {
    const id = ctx.request.headers.get('x-user');
    return id ? next({ user: { id } }) : new Response(null, { status: 401 });
  }
}

const profileSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(2, 'Too short.')),
  bio: v.optional(v.pipe(v.string(), v.maxLength(10, 'Too long.'))),
  age: v.optional(v.pipe(v.string(), v.transform(Number))), // input string, output number
});

export const UpdateProfileRequest = defineRequest({
  schema: profileSchema,
  authorize: (ctx: HttpContext<AuthState, { id: string }>) => ctx.user.id === ctx.params.id,
});

export class UpdateProfileController {
  static request = UpdateProfileRequest;
  handle(ctx: ContextOf<typeof UpdateProfileRequest>) {
    const age: number | undefined = ctx.body.age; // the output type
    return { name: ctx.body.name, age, id: ctx.params.id, by: ctx.user.id };
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

describe('request validation (REPR)', () => {
  const router = new Router().load(
    defineRoutes((Route) => {
      Route.middleware(Authenticate).put('/users/:id', UpdateProfileController);
    }),
  );
  const put = (id: string, body: unknown, user = id) =>
    router.dispatch(router.routes[0]!, {
      request: new Request(`http://app.test/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-user': user },
      }),
      params: { id },
    });

  it('hands handle() the validated, transformed body', async () => {
    const response = await put('1', { name: '  Ada ', age: '36', ignored: true });
    expect(await response.json()).toEqual({ name: 'Ada', age: 36, id: '1', by: '1' });
  });

  it('authorizes before validating (403 even for invalid input)', async () => {
    await expect(put('1', { name: '' }, '2')).rejects.toMatchObject({ status: 403, message: 'This action is unauthorized.' });
  });

  it('collects field errors like Laravel (422, first message + count)', async () => {
    const error = (await put('1', { name: 'A', bio: 'far too long' }).catch((e: unknown) => e)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
    expect(error.errors).toEqual({ name: ['Too short.'], bio: ['Too long.'] });
    expect(error.message).toBe('Too short. (and 1 more error)');
    expect(error.input).toEqual({ name: 'A', bio: 'far too long' });
  });

  it('names nested fields by path', () => {
    const error = ValidationError.fromIssues(
      [
        { message: 'Required.', path: [{ key: 'address' }, { key: 'city' }] },
        { message: 'Form broken.' },
      ],
      {},
    );
    expect(error.errors).toEqual({ 'address.city': ['Required.'], _: ['Form broken.'] });
  });

  it('never builds the controller for rejected requests', async () => {
    let built = 0;
    class Counting extends UpdateProfileController {
      constructor() {
        super();
        built++;
      }
    }
    const counting = new Router().load(defineRoutes((Route) => Route.middleware(Authenticate).put('/users/:id', Counting)));
    const request = new Request('http://app.test/users/1', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json', 'x-user': '1' } });
    await expect(counting.dispatch(counting.routes[0]!, { request, params: { id: '1' } })).rejects.toBeInstanceOf(ValidationError);
    expect(built).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Type guarantees — the nine cases of the E13 type spike. Never called.
// ---------------------------------------------------------------------------

declare const AuthRoute: Route<AuthState>;
declare const GuestRoute: Route<EmptyObject>;

export function typeLevelTests(): void {
  AuthRoute.put('/users/:id', UpdateProfileController);
  AuthRoute.put('/users/:id', (ctx) => ctx.user.id + ctx.params.id); // closures keep their contextual type
  // @ts-expect-error -- 1: a guest route has no `user` (authorize and handle need it)
  GuestRoute.put('/users/:id', UpdateProfileController);
  // @ts-expect-error -- 2: no `:id` parameter
  AuthRoute.put('/users', UpdateProfileController);

  // handle expects a body the schema does not produce
  class WrongBody {
    static request = defineRequest({ schema: profileSchema });
    handle(ctx: HttpContext<{ body: { name: number } }>) {
      return ctx.body.name;
    }
  }
  // @ts-expect-error -- 3: body.name is a string, not a number
  AuthRoute.put('/x', WrongBody);

  // handle needs a body, but nothing validates one
  class NoRequest {
    handle(ctx: HttpContext<AuthState & { body: { name: string } }>) {
      return ctx.body.name;
    }
  }
  // @ts-expect-error -- 4: no request → no body
  AuthRoute.put('/y', NoRequest);

  // only authorize needs `user` — the hole a union type would have had
  const AdminRequest = defineRequest({ schema: profileSchema, authorize: (ctx: HttpContext<AuthState>) => ctx.user.id === '1' });
  class AdminOnly {
    static request = AdminRequest;
    handle(ctx: HttpContext<Validated<typeof AdminRequest>>) {
      return ctx.body.name;
    }
  }
  AuthRoute.put('/z', AdminOnly);
  // @ts-expect-error -- 5: authorize needs `user`, the guest route has none
  GuestRoute.put('/z', AdminOnly);

  // handle validates against a different request than the one attached
  const ContactRequest = defineRequest({ schema: v.object({ message: v.string() }) });
  class MixedUp {
    static request = ContactRequest;
    handle(ctx: ContextOf<typeof UpdateProfileRequest>) {
      return ctx.body.name;
    }
  }
  // @ts-expect-error -- 6: the body is { message }, handle expects { name, … }
  AuthRoute.put('/users/:id', MixedUp);

  // Forms get the schema's *input* type, from the controller instance (like PageProps<C>)
  expectTypeOf<FormOf<UpdateProfileController>>().toEqualTypeOf<{ name: string; bio?: string | undefined; age?: string | undefined }>();
  const form: FormOf<UpdateProfileController> = { name: 'Ada', age: '36' };
  // @ts-expect-error -- 7: `age` is sent as a string (input), not the transformed number
  const wrongForm: FormOf<UpdateProfileController> = { name: 'Ada', age: 36 };
  // @ts-expect-error -- 8: a controller without request has no form
  const noForm: FormOf<NoRequest> = { name: 'x' };
  // @ts-expect-error -- 9: unknown field
  const typo: FormOf<UpdateProfileController> = { nmae: 'Ada' };
  void [form, wrongForm, noForm, typo];
}
