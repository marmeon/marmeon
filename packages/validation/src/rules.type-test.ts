// Type guarantees of the rules (W10 step 3, E197) — checked by `tsc` (pnpm build / typecheck), never run. The messages, as the
// compiler shows them (directives removed once and read), are quoted in the comments.
import { defineConfig, type ConfigOf } from '@marmeon/core';
import { defineRequest, type ContextOf, type FormOf, type QueryOf } from '@marmeon/router';
import { rules as r } from './index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(proof: Equal<A, B>) => proof;

/** A repository as @marmeon/database's are: `query()`, and `find()` says what a row has. */
class UserRepository {
  query(): unknown {
    return undefined;
  }
  find(_id: number): Promise<{ id: number; name: string; email: string } | undefined> {
    return Promise.resolve(undefined);
  }
}

// ——— The plan's sketch ———

export const UpdateProfileRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().max(255),
    email: r.string().trim().lowercase().required().email().max(255).unique(UserRepository, 'email', { ignore: (ctx) => ctx.user.id }),
    website: r.url().nullable(),
    tags: r.array(r.string().max(30)).max(10).default([]),
  }),
  messages: { 'email.unique': 'profile.validation.email_taken' },
  attributes: { email: 'profile.fields.email' },
});

class UpdateProfileController {
  static request = UpdateProfileRequest;
  handle(ctx: ContextOf<typeof UpdateProfileRequest>) {
    // What the handler gets: the output — every field there, `tags` filled in.
    same<typeof ctx.body, { name: string; email: string; website: string | null; tags: string[] }>(true);
    return ctx.body;
  }
}

// What the browser sends: the input — `tags` may be left out (it has a default).
same<FormOf<UpdateProfileController>, { name: string; email: string; website: string | null; tags?: string[] | undefined }>(true);

export const ListPeopleRequest = defineRequest({
  query: r.query({ sort: r.in(['name', '-name']).default('name'), page: r.integer().min(1).default(1), per_page: r.in([10, 25, 50]).default(10), q: r.string().optional() }),
});

class ListPeopleController {
  static request = ListPeopleRequest;
  handle(ctx: ContextOf<typeof ListPeopleRequest>) {
    return ctx.query;
  }
}

// Strings in, typed values out: `page` a number, `per_page` one of the sizes — every field there but the optional one.
same<QueryOf<ListPeopleController>, { sort: 'name' | '-name'; page: number; per_page: 10 | 25 | 50; q?: string | undefined }>(true);

// Type 'NumberRule' is not assignable to type 'NumberRule & "Query field 'page' needs .default(…) — …"'.
//   Type 'NumberRule' is not assignable to type '"Query field 'page' needs .default(…) — a query is parsed field by field and never
//   answers 422 (E56); .optional() leaves it undefined"'.
// @ts-expect-error — a query field without a default
r.query({ page: r.integer().min(1) });

// Type 'Rule<{ city: string; } | undefined, { city: string; } | undefined>' is not assignable to type '"Query field 'address' is read
// from the URL as text — give it a rule that takes a string: r.string(), r.integer(), r.boolean(), r.in([…]), r.array(…)"'.
// @ts-expect-error — an object cannot come from a URL
r.query({ address: r.object({ city: r.string() }).optional() });

const AppConfig = defineConfig('app', {
  env: r.env({ APP_PORT: r.port().default(3960), INVITES: r.boolean().default(false), ADMINS: r.list(r.email()).default([]), APP_NAME: r.string().required() }),
  resolve: (env) => ({ port: env.APP_PORT, invites: env.INVITES, admins: env.ADMINS, name: env.APP_NAME }),
});
same<ConfigOf<typeof AppConfig>, { port: number; invites: boolean; admins: string[]; name: string }>(true);

// Type 'ArrayRule<string, string, string[]>' is not assignable to type '"Environment variable 'TAGS' is text — give it a rule that
// takes a string: r.string(), r.integer(), r.boolean(), r.port(), r.list(…)"'. (Each message comes after the line naming the intersection.)
// @ts-expect-error — r.array() reads no string (r.list() does)
r.env({ TAGS: r.array(r.string()) });

// ——— The output changes with the modifiers and transform ———

same<ReturnType<typeof r.string>['~standard']['types'], { readonly input: string; readonly output: string } | undefined>(true);
const optional = r.string().max(3).optional();
same<NonNullable<(typeof optional)['~standard']['types']>, { readonly input: string | undefined; readonly output: string | undefined }>(true);
const nullable = r.integer().nullable();
same<NonNullable<(typeof nullable)['~standard']['types']>, { readonly input: number | `${number}` | null; readonly output: number | null }>(true);
const filled = r.boolean().default(false);
same<NonNullable<(typeof filled)['~standard']['types']>['output'], boolean>(true);
const words = r.string().trim().transform((text) => text.split(' '));
same<NonNullable<(typeof words)['~standard']['types']>, { readonly input: string; readonly output: string[] }>(true);
const counted = r.string().transform(async (text) => text.length);
same<NonNullable<(typeof counted)['~standard']['types']>['output'], number>(true);
const either = r.union([r.literal('all'), r.integer()]);
same<NonNullable<(typeof either)['~standard']['types']>['output'], 'all' | number>(true);
const terms = r.accepted();
same<NonNullable<(typeof terms)['~standard']['types']>['output'], true>(true);

// Conditional fields are optional in what comes out.
const company = r.object({ kind: r.in(['person', 'company']) }).when((data) => data.kind === 'company', { vat: r.string().required() });
same<NonNullable<(typeof company)['~standard']['types']>['output'], { kind: 'person' | 'company'; vat?: string | undefined }>(true);

// Property 'max' does not exist on type 'Rule<string | undefined, string | undefined>'.
// @ts-expect-error — the modifiers come last: after optional() the string's rules are gone
r.string().optional().max(3);

// Argument of type 'string' is not assignable to parameter of type 'number'.
// @ts-expect-error — a default is a value of the rule's output
r.integer().default('1');

// Argument of type '"mail"' is not assignable to parameter of type '"email" | "id" | "name"'.
// @ts-expect-error — unique() names a column of the repository's rows
r.string().unique(UserRepository, 'mail');

// Argument of type '"nope"' is not assignable to parameter of type '"kind"'.
// @ts-expect-error — confirmed() names a field of the object
company.confirmed('nope');

// A when-condition sees the other fields' output.
r.object({ count: r.integer() }).when((data) => data.count > 2, { reason: r.string() });

// ——— W10 step 4: entries, r.value(), message functions ———

// An object's entries spread into another query keep their types.
const paging = r.query({ page: r.integer().min(1).default(1) });
const withTab = r.query({ ...paging.entries, tab: r.in(['all', 'mine']).default('all') });
export const ListWithTabRequest = defineRequest({ query: withTab });
same<NonNullable<(typeof withTab)['~standard']['types']>['output'], { page: number; tab: 'all' | 'mine' }>(true);

// r.value(): its own output and input — a form sends the input.
class Upload {
  readonly size = 0;
}
const file = r.value<Upload, string | null>((value) => (value instanceof Upload ? undefined : 'Choose a file.'));
const avatarForm = r.object({ avatar: file, cover: file.nullable() });
same<NonNullable<(typeof avatarForm)['~standard']['types']>['output'], { avatar: Upload; cover: Upload | null }>(true);
type AvatarInput = NonNullable<(typeof avatarForm)['~standard']['types']>['input'];
export const sent: AvatarInput = { avatar: 'token', cover: null };
export const back: { avatar: string | null; cover: string | null } = sent;

// A message may be a function (translatable()/trans()) — a number is none.
r.string().custom((value) => value !== '', (_issue: object) => 'Fill this in.');
// Argument of type '42' is not assignable to parameter of type 'RuleMessage | undefined'.
// @ts-expect-error — a message is a key, a text or a message function
r.string().regex(/x/, 42);

// Type 'number' is not assignable to type 'void | RuleMessage | undefined'. — r.value()'s check answers a message or nothing.
// @ts-expect-error — a check answers a message, never a number
r.value<string>(() => 1);

// ——— .live() belongs on a field, never on a container (W10 step 9b, E197) ———

r.object({ slug: r.string().unique(UserRepository, 'email').live() }); // on the field: fine
// @ts-expect-error — on an object it would open every rule inside, the address too
r.object({ email: r.string().unique(UserRepository, 'email') }).live();
// The 'this' context of type 'ObjectRule<{ readonly email: StringRule; }, {}>' is not assignable to method's 'this' of type '".live() goes on
// the field whose being taken is no secret — r.object({ slug: r.string().unique(Teams, 'slug').live() }) — never on an object, a list
// or a union: it would open every rule inside (E197)."'.
// @ts-expect-error — on a list: put it on the item rule
r.array(r.string().unique(UserRepository, 'email')).live();
