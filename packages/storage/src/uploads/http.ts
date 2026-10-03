import type { Container, Resolver } from '@bespokecore/core';
import { HttpError, type ClassResolver, type HttpContext, type RequestDefinition, type StandardSchemaV1 } from '@bespokecore/router';
import { RejectedUpload } from './temporary-upload.ts';
import { uploadFields } from './rule.ts';
import type { TemporaryUploads } from './service.ts';

type Http = typeof import('@bespokecore/http');

/** Where the bytes of a local (or memory) upload go: `PUT /_bespoke/uploads/<id>?expires=…&signature=…`. */
export const UPLOADS_PREFIX = '/_bespoke/uploads';

/** A field path an upload target may name (`avatar`, `profile.photo`). */
const FIELD = /^[\w-]{1,100}(?:\.[\w-]{1,100}){0,9}$/;

/** The session's scope (a hash of its id) — what an upload belongs to; undefined without a session. */
function sessionScope(http: Http, resolve: (key: unknown) => unknown): string | undefined {
  try {
    return (resolve(http.PageSession) as { scope(): string | undefined }).scope();
  } catch {
    return undefined; // no session in this app (or on this route)
  }
}

/** The body schema of a request definition — built by its factory, when it has one. */
function bodySchema(request: RequestDefinition | undefined, resolve: ClassResolver): StandardSchemaV1 | undefined {
  if (!request?.schema) return undefined;
  return typeof request.schema === 'function' ? request.schema(resolve) : request.schema;
}

/** The value at `path` in `input`, with the object holding it. */
function locate(input: Record<string, unknown>, path: string): { holder: Record<string, unknown>; key: string } | undefined {
  const segments = path.split('.');
  let holder: unknown = input;
  for (const segment of segments.slice(0, -1)) {
    holder = (holder as Record<string, unknown> | undefined)?.[segment];
    if (typeof holder !== 'object' || holder === null) return undefined;
  }
  return { holder: holder as Record<string, unknown>, key: segments.at(-1)! };
}

/**
 * Wires uploads into the router (W6.9):
 *
 * 1. **The target** — the form's own route, its method and URL, with `x-bespoke-upload: <field>`: the route's middleware,
 *    bindings and `authorize` run (who may send the form may upload its files, by the same rules), its controller does not;
 *    the field's `upload()` rule decides the limit. No such rule: 404.
 * 2. **The bytes** — `PUT /_bespoke/uploads/<id>` behind a signature, for the session the target was made for.
 * 3. **The submit** — before the body schema runs, every upload field's token is replaced by the verified upload (or why it
 *    is refused), which the `upload()` rule then checks.
 */
export function registerUploads(http: Http, container: Container, uploads: () => TemporaryUploads): void {
  const router = container.make(http.Router);

  router.intercept({
    claims: (request) => request.headers.has(http.UPLOAD_HEADER) && !new URL(request.url).pathname.startsWith(`${UPLOADS_PREFIX}/`),
    answer: async (ctx: HttpContext, request, resolve) => {
      const field = ctx.request.headers.get(http.UPLOAD_HEADER)!;
      const method = ctx.request.method;
      const route = ctx.route.routeName;
      const rule = FIELD.test(field) && method !== 'GET' && method !== 'HEAD' && route ? uploadFields(bodySchema(request, resolve)).get(field) : undefined;
      if (!rule || !route) throw new HttpError(404);
      const session = sessionScope(http, resolve as (key: unknown) => unknown);
      if (!session) throw new HttpError(419, 'Page Expired', {}, { key: 'bespoke.status.419' });
      const input = await ctx.input();
      const { name, size } = input;
      if (typeof name !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        throw new HttpError(400, 'An upload target needs the file’s name and size: { name, size }.');
      }
      const target = await uploads().target({ route, field, rule, session, name, size });
      return Response.json(target, { headers: { 'cache-control': 'no-store' } });
    },
  });

  router.beforeValidation(async (input, { ctx, schema, resolve }) => {
    const fields = uploadFields(schema);
    if (fields.size === 0) return;
    const route = ctx.route.routeName;
    const session = sessionScope(http, resolve as (key: unknown) => unknown);
    for (const field of fields.keys()) {
      const place = locate(input, field);
      if (!place || !Object.hasOwn(place.holder, place.key)) continue;
      const value = place.holder[place.key];
      if (value === null || value === undefined || value === '') continue; // nothing chosen: the rule says "required"
      place.holder[place.key] =
        typeof value === 'string' && route !== undefined && session !== undefined
          ? await uploads().resolve(value, { session, route, field })
          : new RejectedUpload('invalid'); // a file in the body, a list, an object: never an upload
    }
  });

  class ReceiveUploadController {
    readonly #session: () => string | undefined;

    constructor(session: () => string | undefined) {
      this.#session = session;
    }

    async handle(ctx: HttpContext<{}, { id: string }>): Promise<Response> {
      const session = this.#session();
      if (!session) throw new HttpError(419, 'Page Expired', {}, { key: 'bespoke.status.419' });
      const length = ctx.request.headers.get('content-length');
      const declared = length !== null && /^\d{1,16}$/.test(length) ? Number(length) : undefined;
      const size = await uploads().receive(ctx.params.id, session, ctx.request.body, declared);
      return Response.json({ size }, { headers: { 'cache-control': 'no-store' } });
    }
  }
  container.scoped(ReceiveUploadController, (scope: Resolver) => new ReceiveUploadController(() => sessionScope(http, (key) => scope.make(key as never))));

  router.load(
    { group: 'web' },
    http.defineRoutes((Route) => {
      Route.middleware(http.signed()).put(`${UPLOADS_PREFIX}/:id`, ReceiveUploadController);
    }),
  );
}
