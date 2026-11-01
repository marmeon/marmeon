// Type guarantees of the rules — checked by `tsc` (pnpm build / typecheck), never run. The messages, as the
// compiler shows them (directives removed once and read), are quoted in the comments.
import { defineRequest, type ContextOf, type FormOf, type QueryOf } from '@marmeon/router';
import { rules as r } from './index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(proof: Equal<A, B>) => proof;

/** A query as the repositories' are: its `where()` takes the columns of the rows and a value of the column's type. */
interface UserQuery {
  where<C extends 'id' | 'name' | 'email'>(column: C, operator: '=' | '<>', value: { id: number; name: string; email: string }[C]): UserQuery;
}

/** A repository as @marmeon/database's are: `query()`, and `find()` says what a row has. */
class UserRepository {
  query(): UserQuery {
    throw new Error('never run');
  }
  find(_id: number): Promise<{ id: number; name: string; email: string } | undefined> {
    return Promise.resolve(undefined);
  }
}

// ——— A request's schema ———

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
//   answers 422; .optional() leaves it undefined"'.
// @ts-expect-error — a query field without a default
r.query({ page: r.integer().min(1) });

// Type 'Rule<{ city: string; } | undefined, { city: string; } | undefined>' is not assignable to type '"Query field 'address' is read
// from the URL as text — give it a rule that takes a string: r.string(), r.integer(), r.boolean(), r.in([…]), r.array(…)"'.
// @ts-expect-error — an object cannot come from a URL
r.query({ address: r.object({ city: r.string() }).optional() });

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

// ——— The query of unique() and exists(): the repository's ———

type Workspace = { id: number };
type Scoped = { user: { id: number }; params: { workspace: Workspace } };

r.integer().exists(UserRepository, 'id', { where: (query, ctx: Scoped) => query.where('id', '=', ctx.params.workspace.id) }); // typed ctx: fine
r.string().unique(UserRepository, 'email', { where: (query) => query.where('name', '=', 'Ada') }); // an untyped ctx stays any: fine

// @ts-expect-error — the column of `where` is one of the repository's rows
r.integer().exists(UserRepository, 'id', { where: (query) => query.where('team_id', '=', 1) });

// @ts-expect-error — the value has the column's type
r.integer().exists(UserRepository, 'id', { where: (query) => query.where('id', '=', 'one') });

// @ts-expect-error — a callback that returns something else than the query
r.string().unique(UserRepository, 'email', { where: () => 'nothing' });

// @ts-expect-error — a typo in an annotated ctx
r.integer().exists(UserRepository, 'id', { where: (query, ctx: Scoped) => query.where('id', '=', ctx.params.workspce.id) });

// @ts-expect-error — the callback takes the repository's query, not another one
r.integer().exists(UserRepository, 'id', { where: (query: { select(): void }) => query });

// Argument of type '"nope"' is not assignable to parameter of type '"kind"'.
// @ts-expect-error — confirmed() names a field of the object
company.confirmed('nope');

// A when-condition sees the other fields' output.
r.object({ count: r.integer() }).when((data) => data.count > 2, { reason: r.string() });

// ——— Entries, r.value(), message functions ———

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

// ——— .live() belongs on a field, never on a container ———

r.object({ slug: r.string().unique(UserRepository, 'email').live() }); // on the field: fine
// @ts-expect-error — on an object it would open every rule inside, the address too
r.object({ email: r.string().unique(UserRepository, 'email') }).live();
// The 'this' context of type 'ObjectRule<{ readonly email: StringRule; }, {}>' is not assignable to method's 'this' of type '".live() goes on
// the field whose being taken is no secret — r.object({ slug: r.string().unique(Teams, 'slug').live() }) — never on an object, a list
// or a union: it would open every rule inside."'.
// @ts-expect-error — on a list: put it on the item rule
r.array(r.string().unique(UserRepository, 'email')).live();

// ——— An empty string, by type: the types stay — '' is a string, and what a rule keeps is in its output ———

export const BlockRequest = defineRequest({ schema: r.object({ title: r.string().trim().required(), subtitle: r.string().max(120).optional(), style: r.in(['', 'bold']).optional() }) });
class BlockController {
  static request = BlockRequest;
  handle(ctx: ContextOf<typeof BlockRequest>) {
    // A subtitle cleared on purpose arrives as '' — a string; left out it is undefined.
    same<typeof ctx.body, { title: string; subtitle?: string | undefined; style?: '' | 'bold' | undefined }>(true);
    return ctx.body;
  }
}
// What a page builder sends to clear it.
export const cleared: FormOf<BlockController> = { title: 'Pricing', subtitle: '', style: '' };
// r.in() without '' among its options never gives '' (an empty <select> is missing there).
const align = r.in(['left', 'center']).optional();
same<NonNullable<(typeof align)['~standard']['types']>['output'], 'left' | 'center' | undefined>(true);

// ——— An object's custom() ———
const ends = r.object({ starts_at: r.string(), ends_at: r.string() });
const never = () => true;
ends.custom(never, { field: 'ends_at' }); // fine
ends.custom(never, { message: 'The end comes before the start.', field: 'starts_at' }); // fine
ends.custom(never, 'The end comes before the start.'); // fine
// @ts-expect-error — a typo in the field
ends.custom(never, { field: 'end_at' });
// @ts-expect-error — only an object's check reports at a field
r.string().custom(never, { field: 'x' });
// @ts-expect-error — the other rules take a message, not options
r.string().custom(never, { message: 'x' });
// A later condition sees the fields of the earlier blocks, optional; a field no block has stays an error.
r.object({ kind: r.in(['a', 'b']) })
  .when((data) => data.kind === 'b', { mid: r.in(['yes', 'no']) })
  .when((data) => {
    const mid: 'yes' | 'no' | undefined = data.mid;
    // @ts-expect-error — an earlier block's field may be absent
    const sure: 'yes' | 'no' = data.mid;
    void sure;
    // @ts-expect-error — no block has this field
    data.nothing;
    return mid === 'yes';
  }, { last: r.string() });

// A block that repeats a base key does not narrow it for the next condition: the block may have been skipped.
r.object({ kind: r.in(['a', 'b']) })
  .when((data) => data.kind === 'b', { kind: r.literal('b'), extra: r.string() })
  .when((data) => data.kind === 'a' && data.extra === undefined, { last: r.string() });

// A block that repeats a base key may replace its value: the output and the next condition see either type.
const replaced = r.object({ n: r.string() }).when((d) => d.n === '5', { n: r.number() });
same<NonNullable<(typeof replaced)['~standard']['types']>['output'], { n: string | number }>(true);
same<NonNullable<(typeof replaced)['~standard']['types']>['input'], { n: string }>(true);
replaced.when((d) => {
  const n: string | number = d.n;
  return n === 5;
}, { m: r.string() });
// Two blocks that share a field: it is optional and either type.
const twice = r.object({ k: r.string() }).when((d) => d.k === 'a', { x: r.literal('a') }).when((d) => d.k === 'b', { x: r.literal('b') });
same<NonNullable<(typeof twice)['~standard']['types']>['output'], { k: string; x?: 'a' | 'b' | undefined }>(true);

// @ts-expect-error — a field of when() is not there before .when()
ends.custom(never, { field: 'vat' });
r.object({ kind: r.in(['a', 'b']) }).when((data) => data.kind === 'b', { vat: r.string() }).custom(never, { field: 'vat' }); // fine

// ——— A local date and time ———
const zoned = r.object({ time_zone: r.timeZone(), starts_at: r.localDateTime({ field: 'time_zone' }), ends_at: r.localDateTime('Europe/Berlin').optional() });
same<NonNullable<(typeof zoned)['~standard']['types']>['output'], { time_zone: string; starts_at: string; ends_at?: string | undefined }>(true);
r.localDateTime((request) => (request ? 'UTC' : undefined)); // fine
// @ts-expect-error — a zone is a name, { field } or a function
r.localDateTime(2);
// @ts-expect-error — { field } names a field
r.localDateTime({ zone: 'time_zone' });

// ——— A field an object spreads in only sometimes ———
declare const withGuests: boolean;
const registration = r.object({ name: r.string(), ...(withGuests ? { guests: r.array(r.object({ name: r.string(), email: r.string() })) } : {}) });
type RegistrationTypes = NonNullable<(typeof registration)['~standard']['types']>;
same<RegistrationTypes['output'], { name: string; guests?: { name: string; email: string }[] | undefined }>(true);
same<RegistrationTypes['input'], { name: string; guests?: { name: string; email: string }[] | undefined }>(true);
class RegisterController {
  static request = defineRequest({ schema: registration });
  handle(ctx: ContextOf<typeof RegisterController.request>) {
    return ctx.body;
  }
}
same<FormOf<RegisterController>, { name: string; guests?: { name: string; email: string }[] | undefined }>(true);
// @ts-expect-error — the spread field is not a number
export const guestsAsNumber: RegistrationTypes['output']['guests'] extends number | undefined ? true : false = true;

// A rule looked up in a record may be missing — under noUncheckedIndexedAccess that is a type error, not a field.
declare const shared: Record<string, ReturnType<typeof r.string>>;
// @ts-expect-error — shared['term'] may be undefined
r.object({ terms: shared['term'] });
